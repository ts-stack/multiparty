import http = require('http');
import util = require('util');

import { Form } from '../dist';

const PORT = process.env.PORT || 27372;

const server = http.createServer((req, res) => {
  if (req.url == '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      '<form action="/upload" enctype="multipart/form-data" method="post">' +
        '<input type="text" name="title"><br>' +
        '<input type="file" name="upload" multiple="multiple"><br>' +
        '<input type="submit" value="Upload">' +
        '</form>'
    );
  } else if (req.url == '/upload') {
    const form = new Form();

    form.parse(req, (err, fields, files) => {
      if (err) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('invalid request: ' + err.message);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('received fields:\n\n ' + util.inspect(fields));
      res.write('\n\n');
      res.end('received files:\n\n ' + util.inspect(files));
    });
  } else {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('404');
  }
});

server.listen(PORT, () => {
  console.log('listening on http://0.0.0.0:' + PORT + '/');
});
