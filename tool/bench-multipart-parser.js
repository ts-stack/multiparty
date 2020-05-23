var assert = require('assert')
var Form = require('../dist').Form

var BOUNDARY = '-----------------------------168072824752491622650073'
var SIZE_MB = 100
var BUFFER = createMultipartBuffer(BOUNDARY, SIZE_MB * 1024 * 1024)

var callbacks = {
  partBegin: -1,
  partEnd: -1,
  headerField: -1,
  headerValue: -1,
  partData: -1,
  end: -1
};

var form = new Form({ boundary: BOUNDARY });

hijack('onParseHeaderField', function() {
  callbacks.headerField++;
});

hijack('onParseHeaderValue', function() {
  callbacks.headerValue++;
});

hijack('onParsePartBegin', function() {
  callbacks.partBegin++;
});

hijack('onParsePartData', function() {
  callbacks.partData++;
});

hijack('onParsePartEnd', function() {
  callbacks.partEnd++;
});

form.on('finish', function() {
  callbacks.end++;
});

var start = new Date();
form.write(BUFFER, function(err) {
  var duration = new Date() - start;
  assert.ifError(err);
  var mbPerSec = (SIZE_MB / (duration / 1000)).toFixed(2);
  console.log(mbPerSec+' mb/sec');
});

process.on('exit', function() {
  for (var k in callbacks) {
    assert.equal(0, callbacks[k], k+' count off by '+callbacks[k]);
  }
});

function createMultipartBuffer(boundary, size) {
  var buffer = Buffer.alloc(size)
  var head =
        '--'+boundary+'\r\n' +
        'content-disposition: form-data; name="field1"\r\n' +
        '\r\n'
  var tail = '\r\n--'+boundary+'--\r\n'

  buffer.write(head, 'ascii', 0);
  buffer.write(tail, 'ascii', buffer.length - tail.length);
  return buffer;
}

function hijack(name, fn) {
  var oldFn = form[name];
  form[name] = function() {
    fn();
    return oldFn.apply(this, arguments);
  };
}

