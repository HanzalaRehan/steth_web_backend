const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

// Swappable shipping-label interface. Today's implementation is a pure-Node
// stub (no carrier integration exists yet, per Part B.1 - "no carrier/script
// details provided"). A real carrier integration later (subprocess, external
// HTTP API, carrier SDK) only has to replace what happens inside
// generateLabel() - route handlers never see or hardcode a carrier.
//
// Writes to src/temp/, the same directory upload.middleware.js already uses
// for pre-ImageKit-upload files - uploadToImageKit() deletes the file after
// upload, so nothing lingers.
const generateLabel = (order) => {
  return new Promise((resolve, reject) => {
    const tempDir = path.join(__dirname, '..', 'temp');
    fs.mkdirSync(tempDir, { recursive: true });

    const fileName = `label-${order.orderId || order._id}-${Date.now()}.pdf`;
    const filePath = path.join(tempDir, fileName);

    const doc = new PDFDocument({ size: 'A6', margin: 20 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    doc.fontSize(14).font('Helvetica-Bold').text('STETH - Shipping Label', { align: 'center' });
    doc.moveDown();
    doc.fontSize(10).font('Helvetica').text(`Order: ${order.orderId || order._id}`);
    doc.moveDown(0.5);

    doc.font('Helvetica-Bold').text('Ship To:');
    doc.font('Helvetica').text(order.shippingAddress?.fullName || '');
    doc.text(order.shippingAddress?.addressLine1 || '');
    if (order.shippingAddress?.addressLine2) doc.text(order.shippingAddress.addressLine2);
    doc.text(`${order.shippingAddress?.city || ''}, ${order.shippingAddress?.state || ''} ${order.shippingAddress?.postalCode || ''}`);
    doc.text(order.shippingAddress?.country || '');
    doc.text(order.shippingAddress?.phoneNumber || '');
    doc.moveDown(0.5);

    doc.font('Helvetica-Bold').text('Items:');
    doc.font('Helvetica');
    (order.items || []).forEach((item) => {
      doc.text(`${item.quantity}x ${item.productName} - ${item.color} (${item.size})`);
    });

    doc.end();

    stream.on('finish', () => resolve(filePath));
    stream.on('error', reject);
  });
};

module.exports = { generateLabel };
