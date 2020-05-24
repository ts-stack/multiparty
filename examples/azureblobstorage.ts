import http = require('http');
const azure = require('azure');

import { Form } from '../dist';

const PORT = process.env.PORT || 27372;

const server = http.createServer((req, res) => {
  if (req.url == '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      '<form action="/upload" enctype="multipart/form-data" method="post">' +
        '<input type="text" name="title"><br>' +
        '<input type="file" name="upload"><br>' +
        '<input type="submit" value="Upload">' +
        '</form>'
    );
  } else if (req.url == '/upload') {
    const blobService = azure.createBlobService();
    const form = new Form();

    form.on('part', (part) => {
      if (!part.filename) return;

      const size = part.byteCount;
      const name = part.filename;
      const container = 'blobContainerName';

      blobService.createBlockBlobFromStream(container, name, part, size, (error) => {
        if (error) {
          // error handling
          res.statusCode = 500;
          res.end('Error uploading file');
        }
        res.end('File uploaded successfully');
      });
    });

    form.parse(req);
  }
});

server.listen(PORT, () => {
  console.info('listening on http://0.0.0.0:' + PORT + '/');
});
