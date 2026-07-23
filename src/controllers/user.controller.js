require('dotenv').config();
const User = require('../models/user.model');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
// const { sendOtp } = require('../services/sendOtp');
// const { reSendOtp } = require('../services/sendOtp');
const mongoose = require('mongoose'); // Add this line

const path = require('path');
const fs = require('fs');
const { uploadToImageKit } = require('../utils/imageKitUpload');
const { sendOtp,reSendOtp } = require('../utils/emailService');
const { OAuth2Client } = require('google-auth-library');
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const googleAuthUser = async (req, res) => {
  try {
    const { id_token } = req.body;

    if (!id_token) {
      return res.status(400).json({ message: 'No ID token provided' });
    }

    const ticket = await client.verifyIdToken({
      idToken: id_token,
      audience: process.env.GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();
    const { email, name, sub: googleId } = payload;

    // Check if user already exists
    let user = await User.findOne({ email });

    if (!user) {
      // Create a new user without password
      user = new User({
        username: name.replace(/\s+/g, '_').toLowerCase(),
        email,
        password: '', // No password because it's Google-authenticated
        authProvider: 'google',
        googleId,
        isVerified: true // Google-authenticated accounts are pre-verified
      });
      await user.save();
    }

    const tokenPayload = {
      id: user._id,
      username: user.username,
      email: user.email,
      role: user.role
    };

    const accessToken = jwt.sign(tokenPayload, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '1h' });

    res.status(200).json({ message: 'Login with Google successful', accessToken, role: user.role });
  } catch (err) {
    console.error('Google login error:', err);
    res.status(400).json({ message: 'Invalid Google token' });
  }
};


const registerUser = async (req, res) => {
  try {
    const { username, email, password } = req.body;

    // Check if MongoDB is connected
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ message: 'Database connection unavailable' });
    }

    if (!username || !email || !password) {
      return res.status(400).json({ message: 'Fill all fields' });
    }

    const isPasswordValid = /^(?=.*\d)(?=.*[\W_]).{8,}$/.test(password);
    if (!isPasswordValid) {
      return res.status(400).json({
        message: 'Password must be at least 8 characters long, include at least one special character, and contain at least one number.',
      });
    }

    const isEmailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!isEmailValid) {
      return res.status(400).json({ message: 'Enter a valid email format' });
    }

    // Add timeout to database queries
    const checkExisting = await Promise.race([
      Promise.all([
        User.findOne({ username }),
        User.findOne({ email })
      ]),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Database query timeout')), 10000)
      )
    ]);

    const [userAlreadyExists, mailAlreadyExists] = checkExisting;

    if (userAlreadyExists) {
      return res.status(400).json({ message: 'Username already exists' });
    }

    if (mailAlreadyExists) {
      return res.status(400).json({ message: 'Email already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = new User({ username, email, password: hashedPassword });
    
    await Promise.race([
      newUser.save(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Database save timeout')), 10000)
      )
    ]);

    try {
      await sendOtp(newUser);
    } catch (otpErr) {
      console.error('Failed to send registration OTP:', otpErr);
    }

    res.status(201).json({
      message: 'Registration successful. Please check your email for a verification code.',
      email: newUser.email
    });
  } catch (err) {
    console.error('Registration error:', err);
    
    if (err.message.includes('timeout')) {
      return res.status(503).json({ 
        message: 'Database connection timeout. Please check your connection and try again.' 
      });
    }
    
    if (err.name === 'MongoTimeoutError' || err.name === 'MongooseError') {
      return res.status(503).json({ 
        message: 'Database connection issue. Please try again later.' 
      });
    }
    
    res.status(500).json({ message: 'Server error' });
  }
};

const loginUser = async (req, res) => {
  try {
    const { usernameOrEmail, password } = req.body;

    if (!usernameOrEmail || !password) {
      return res.status(400).json({ message: 'Fill all fields' });
    }

    // Check if user exists with either username or email
    const user = await User.findOne({
      $or: [
        { username: usernameOrEmail },
        { email: usernameOrEmail }
      ]
    });

    if (!user) {
      return res.status(400).json({ message: 'Invalid username/email or password' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid username/email or password' });
    }

    if (!user.isVerified) {
      return res.status(403).json({
        message: 'Please verify your email before logging in.',
        email: user.email
      });
    }

    const payload = {
      id: user._id,
      username: user.username,
      email: user.email,
      role: user.role
    };

    const accessToken = jwt.sign(payload, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '2d' });

    res.status(200).json({ 
      message: 'Login successful', 
      accessToken, 
      role: user.role 
    });
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: 'Server error' });
  }
};

const profileAccess = async (req, res) => {
  const { id } = req.user;

  try {
      const user = await User.findOne({ _id: id }).lean();

      if (!user) {
          return res.status(400).json({ message: 'User not found' });
      }

      res.status(200).json({ message: 'Profile', user });
  } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Server error' });
  }
};

const profileAccessAdmin = async (req, res) => {
  const id = req.user._id;

  try {
      const user = await User.findOne({ _id: id }).lean();

      if (!user) {
          return res.status(400).json({ message: 'User not found' });
      }

      res.status(200).json({ message: 'Profile', user });
  } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Server error' });
  }
};

const forgotPass = async(req, res) => {
  try {
    const { email } = req.body;

    const isEmailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!isEmailValid) {
      return res.status(400).json({ message: 'Enter a valid email format' });
    }

    const user = await User.findOne({ email });
    if(!user) {
      return res.status(400).json({message: 'User does not exist'});
    }

    // Just send the OTP in this step
    await sendOtp(user);

    res.status(200).json({ 
      message: 'OTP sent to your email',
      email: user.email  // Send back email to use in next step
    });

  } catch (err) {
    console.log(err);
    res.status(500).json({ message: 'Server error' });
  }
};

// New function to verify OTP only
const verifyOtp = async(req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ message: 'Email and OTP are required' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: 'User not found' });
    }

    // Verify OTP
    if (user.otp !== otp) {
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    // Check if OTP has expired
    if (user.otpExpires && user.otpExpires < Date.now()) {
      return res.status(400).json({ message: 'OTP has expired' });
    }

    // Create a token for password reset
    const payload = {
      id: user._id,
      username: user.username,
      email: user.email,
      passwordReset: true // Flag to indicate this is for password reset
    };

    const resetToken = jwt.sign(payload, process.env.RESET_TOKEN_SECRET, { expiresIn: '15m' });

    res.status(200).json({ 
      message: 'OTP verified successfully',
      resetToken // This token will be used to authenticate the password reset request
    });

  } catch (err) {
    console.log(err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Verify OTP sent at registration and mark the account as verified
const verifyRegistrationOtp = async(req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ message: 'Email and OTP are required' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: 'User not found' });
    }

    if (user.isVerified) {
      return res.status(400).json({ message: 'Account already verified' });
    }

    if (user.otp !== otp) {
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    if (user.otpExpires && user.otpExpires < Date.now()) {
      return res.status(400).json({ message: 'OTP has expired' });
    }

    user.isVerified = true;
    user.otp = null;
    user.otpExpires = null;
    await user.save();

    res.status(200).json({ message: 'Email verified successfully. You can now log in.' });
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: 'Server error' });
  }
};

// New function to set new password after OTP verification
const setNewPassword = async(req, res) => {
  try {
    const { newPassword } = req.body;
    const { id } = req.user;

    // Validate password
    const isPasswordValid = /^(?=.*\d)(?=.*[\W_]).{8,}$/.test(newPassword);
    if (!isPasswordValid) {
      return res.status(400).json({
        message: 'Password must be at least 8 characters long, include at least one special character, and contain at least one number.',
      });
    }

    const user = await User.findOne({ _id: id });
    if (!user) {
      return res.status(400).json({ message: 'User not found' });
    }

    // Hash and update password
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    
    // Clear OTP fields
    user.otp = null;
    user.otpExpires = null;

    // Set verified if not already
    if (!user.isVerified) {
      user.isVerified = true;
    }

    await user.save();

    res.status(200).json({ message: 'Password reset successfully' });
  } catch (err) {
    console.log(err);
    if (err.name === 'TokenExpiredError') {
      return res.status(400).json({ message: 'Reset token has expired' });
    }
    res.status(500).json({ message: 'Server error' });
  }
};

const changePass = async (req, res) => {
  try {
    const { oldPassword , newPassword } = req.body;
    const { id } = req.user;

    if(oldPassword == newPassword)
    {
      return res.status(400).json({message : "You entered the same password please change: "});
    }

    const user = await User.findOne({ _id:id });
    if (!user) {
      return res.status(400).json({ message: 'No user found' });
    }

    const isMatch = await bcrypt.compare(oldPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid old password' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    user.password = hashedPassword;
    await user.save();

    res.status(200).json({ message: 'Password updated successfully' });

  } catch (err) {
    console.log(err);
    res.status(500).json({ message: 'Server error' });
  }
};

const uploadPicture = async (req, res) => {
  try {
    const id = req.user._id;
    const user = await User.findById(id);

    if (!user) {
      return res.status(400).json({ message: 'User not found' });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    // Use the imagekit service to upload the image
    const result = await uploadToImageKit(
      file.path, 
      `user/${user._id}`
    );

    // Update user profile with new ImageKit URL
    user.profilePicUrl = result.secure_url;
    await user.save();

    res.status(201).json({ 
      message: 'Profile picture updated successfully', 
      url: result.secure_url 
    });
  } catch (err) {
    console.error('Error uploading profile picture:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

const updateAccount = async (req, res) => {
  try {
    const id = req.user._id;
    const { username, currentPassword, newPassword } = req.body;
    
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Update username if provided
    if (username && username !== user.username) {
      // Check if username already exists
      const usernameExists = await User.findOne({ 
        username, 
        _id: { $ne: id } // Exclude current user
      });
      
      if (usernameExists) {
        return res.status(400).json({ message: 'Username already taken' });
      }
      
      user.username = username;
    }

    // Update password if provided
    if (currentPassword && newPassword) {
      // Verify current password
      const isMatch = await bcrypt.compare(currentPassword, user.password);
      if (!isMatch) {
        return res.status(400).json({ message: 'Current password is incorrect' });
      }

      // Validate new password
      const isPasswordValid = /^(?=.*\d)(?=.*[\W_]).{8,}$/.test(newPassword);
      if (!isPasswordValid) {
        return res.status(400).json({
          message: 'Password must be at least 8 characters long, include at least one special character, and contain at least one number.'
        });
      }

      // Hash and set new password
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      user.password = hashedPassword;
    }

    // Handle profile picture update if there's a file
    if (req.file) {
      try {
        const result = await uploadToImageKit(
          req.file.path, 
          `user/${user._id}`
        );
        user.profilePicUrl = result.secure_url;
      } catch (uploadErr) {
        console.error('Error uploading profile picture during account update:', uploadErr);
        // Continue with other updates even if image upload fails
      }
    }

    // Save the user changes
    await user.save();
    
    res.status(200).json({ 
      message: 'Account updated successfully',
      user: {
        username: user.username,
        email: user.email,
        profilePicUrl: user.profilePicUrl
      }
    });
  } catch (err) {
    console.error('Error updating account:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Add this to your user controller

const resendOtp = async(req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const isEmailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!isEmailValid) {
      return res.status(400).json({ message: 'Enter a valid email format' });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: 'User not found' });
    }

    // Check if last OTP was sent less than 30 seconds ago
    const thirtySecondsAgo = Date.now() - 30 * 1000;
    if (user.otpExpires && (user.otpExpires - (2 * 60 * 1000)) > thirtySecondsAgo) {
      return res.status(429).json({ 
        message: 'Please wait before requesting a new OTP',
        retryAfter: 30 // seconds
      });
    }

    // Send new OTP
    await reSendOtp(user);

    res.status(200).json({ 
      message: 'New OTP sent to your email',
      email: user.email
    });

  } catch (err) {
    console.log(err);
    res.status(500).json({ message: 'Server error' });
  }
};

const auth = async (req, res, next) => {
  try {
    const authHeader = req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'No authentication token provided' });
    }
    
    const token = authHeader.split(' ')[1];
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    const user = await User.findById(decoded.userId).select('-password');
    
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }
    
    req.user = user;
    req.token = token;
    
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: 'Invalid token' });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token expired' });
    }
    res.status(401).json({ message: 'Authentication failed' });
  }
};

module.exports = {
  registerUser,
  loginUser,
  profileAccess,
  forgotPass,
  verifyOtp,
  verifyRegistrationOtp,
  setNewPassword,
  changePass,
  uploadPicture,
  updateAccount,
  resendOtp,
  googleAuthUser,
  auth,
  profileAccessAdmin
};