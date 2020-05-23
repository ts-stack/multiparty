import { Buffer as SafeBuffer } from 'safe-buffer';
import { StringDecoder } from 'string_decoder';
import createError = require('http-errors');
import uid = require('uid-safe');
import fs = require('fs');
import path = require('path');
const fdSlicer = require('fd-slicer');

export const START = 0;
export const END = 11;
const FILE_EXT_RE = /(\.[_\-a-zA-Z0-9]{0,16})[\S\s]*/;

export function flushWriteCbs(self) {
  self.writeCbs.forEach(function (cb) {
    process.nextTick(cb);
  });
  self.writeCbs = [];
  self.backpressure = false;
}

export function getBytesExpected(headers) {
  const contentLength = headers['content-length'];
  if (contentLength) {
    return parseInt(contentLength, 10);
  } else if (headers['transfer-encoding'] == null) {
    return 0;
  } else {
    return null;
  }
}

export function beginFlush(self) {
  self.flushing += 1;
}

export function endFlush(self) {
  self.flushing -= 1;

  if (self.flushing < 0) {
    // if this happens this is a critical bug in multiparty and this stack trace
    // will help us figure it out.
    self.handleError(new Error('unexpected endFlush'));
    return;
  }

  maybeClose(self);
}

export function cleanupOpenFiles(self) {
  self.openedFiles.forEach(function (internalFile) {
    // since fd slicer autoClose is true, destroying the only write stream
    // is guaranteed by the API to close the fd
    internalFile.ws.destroy();

    fs.unlink(internalFile.publicFile.path, function (err) {
      if (err) self.handleError(err);
    });
  });
  self.openedFiles = [];
}

export function holdEmitQueue(self, eventEmitter) {
  const item = { cb: null, ee: eventEmitter, err: null };
  self.emitQueue.push(item);
  return function (cb) {
    item.cb = cb;
    flushEmitQueue(self);
  };
}

export function errorEventQueue(self, eventEmitter, err) {
  const items = self.emitQueue.filter(function (item) {
    return item.ee === eventEmitter;
  });

  if (items.length === 0) {
    eventEmitter.emit('error', err);
    return;
  }

  items.forEach(function (item) {
    item.err = err;
  });
}

export function handlePart(self, partStream) {
  beginFlush(self);
  const emitAndReleaseHold = holdEmitQueue(self, partStream);
  partStream.on('end', function () {
    endFlush(self);
  });
  emitAndReleaseHold(function () {
    self.emit('part', partStream);
  });
}

export function handleFile(self, fileStream) {
  if (self.error) return;
  const publicFile = {
    fieldName: fileStream.name,
    originalFilename: fileStream.filename,
    path: uploadPath(self.uploadDir, fileStream.filename),
    headers: fileStream.headers,
    size: 0,
  };
  const internalFile = {
    publicFile,
    ws: null,
  };
  beginFlush(self); // flush to write stream
  const emitAndReleaseHold = holdEmitQueue(self, fileStream);
  fileStream.on('error', function (err) {
    self.handleError(err);
  });
  fs.open(publicFile.path, 'wx', function (err, fd) {
    if (err) return self.handleError(err);
    const slicer = fdSlicer.createFromFd(fd, { autoClose: true });

    // end option here guarantees that no more than that amount will be written
    // or else an error will be emitted
    internalFile.ws = slicer.createWriteStream({ end: self.maxFilesSize - self.totalFileSize });

    // if an error ocurred while we were waiting for fs.open we handle that
    // cleanup now
    self.openedFiles.push(internalFile);
    if (self.error) return cleanupOpenFiles(self);

    let prevByteCount = 0;
    internalFile.ws.on('error', function (err) {
      self.handleError(err.code === 'ETOOBIG' ? createError(413, err.message, { code: err.code }) : err);
    });
    internalFile.ws.on('progress', function () {
      publicFile.size = internalFile.ws.bytesWritten;
      const delta = publicFile.size - prevByteCount;
      self.totalFileSize += delta;
      prevByteCount = publicFile.size;
    });
    slicer.on('close', function () {
      if (self.error) return;
      emitAndReleaseHold(function () {
        self.emit('file', fileStream.name, publicFile);
      });
      endFlush(self);
    });
    fileStream.pipe(internalFile.ws);
  });

  function uploadPath(baseDir, filename) {
    const ext = path.extname(filename).replace(FILE_EXT_RE, '$1');
    const name = uid.sync(18) + ext;
    return path.join(baseDir, name);
  }
}

export function handleField(self, fieldStream) {
  let value = '';
  const decoder = new StringDecoder(self.encoding);

  beginFlush(self);
  const emitAndReleaseHold = holdEmitQueue(self, fieldStream);
  fieldStream.on('error', function (err) {
    self.handleError(err);
  });
  fieldStream.on('readable', function () {
    const buffer = fieldStream.read();
    if (!buffer) return;

    self.totalFieldSize += buffer.length;
    if (self.totalFieldSize > self.maxFieldsSize) {
      self.handleError(createError(413, 'maxFieldsSize ' + self.maxFieldsSize + ' exceeded'));
      return;
    }
    value += decoder.write(buffer);
  });

  fieldStream.on('end', function () {
    emitAndReleaseHold(function () {
      self.emit('field', fieldStream.name, value);
    });
    endFlush(self);
  });
}

export function setUpParser(self, boundary) {
  self.boundary = SafeBuffer.alloc(boundary.length + 4);
  self.boundary.write('\r\n--', 0, boundary.length + 4, 'ascii');
  self.boundary.write(boundary, 4, boundary.length, 'ascii');
  self.lookbehind = SafeBuffer.alloc(self.boundary.length + 8);
  self.state = START;
  self.boundaryChars = {};
  for (let i = 0; i < self.boundary.length; i++) {
    self.boundaryChars[self.boundary[i]] = true;
  }

  self.index = null;
  self.partBoundaryFlag = false;

  beginFlush(self);
  self.on('finish', function () {
    if (self.state !== END) {
      self.handleError(createError(400, 'stream ended unexpectedly'));
    }
    endFlush(self);
  });
}

function maybeClose(self) {
  if (self.flushing > 0 || self.error) return;

  // go through the emit queue in case any field, file, or part events are
  // waiting to be emitted
  holdEmitQueue(self)(function () {
    // nextTick because the user is listening to part 'end' events and we are
    // using part 'end' events to decide when to emit 'close'. we add our 'end'
    // handler before the user gets a chance to add theirs. So we make sure
    // their 'end' event fires before we emit the 'close' event.
    // this is covered by test/standalone/test-issue-36
    process.nextTick(function () {
      self.emit('close');
    });
  });
}

function flushEmitQueue(self) {
  while (self.emitQueue.length > 0 && self.emitQueue[0].cb) {
    const item = self.emitQueue.shift();

    // invoke the callback
    item.cb();

    if (item.err) {
      // emit the delayed error
      item.ee.emit('error', item.err);
    }
  }
}
