import os = require('os');
import stream = require('stream');
import { Writable } from 'stream';
import { IncomingMessage } from 'http';
import { StringDecoder } from 'string_decoder';
import createError = require('http-errors');

import { FormOptions, Fn, ObjectAny } from './types';
import {
  flushWriteCbs,
  getBytesExpected,
  cleanupOpenFiles,
  errorEventQueue,
  handlePart,
  handleFile,
  START,
  END,
  handleField,
  clearPartVars,
  setUpParser,
  parseFilename,
  lower,
} from './utils';

const START_BOUNDARY = 1;
const HEADER_FIELD_START = 2;
const HEADER_FIELD = 3;
const HEADER_VALUE_START = 4;
const HEADER_VALUE = 5;
const HEADER_VALUE_ALMOST_DONE = 6;
const HEADERS_ALMOST_DONE = 7;
const PART_DATA_START = 8;
const PART_DATA = 9;
const CLOSE_BOUNDARY = 10;

const LF = 10;
const CR = 13;
const SPACE = 32;
const HYPHEN = 45;
const COLON = 58;
const A = 97;
const Z = 122;

const CONTENT_TYPE_RE = /^multipart\/(?:form-data|related)(?:;|$)/i;
const CONTENT_TYPE_PARAM_RE = /;\s*([^=]+)=(?:"([^"]+)"|([^;]+))/gi;
const LAST_BOUNDARY_SUFFIX_LEN = 4; // --\r\n

export class Form extends Writable {
  /**
   * The amount of bytes received for this form so far.
   */
  bytesReceived: number = 0;
  /**
   * The expected number of bytes in this form.
   */
  bytesExpected: number = null;
  protected error: Error = null;
  protected autoFields: boolean;
  protected autoFiles: boolean;
  protected maxFields: number;
  protected maxFieldsSize: number;
  protected maxFilesSize: number;
  protected uploadDir: string;
  protected encoding: string;
  protected openedFiles: string[] = [];
  protected totalFieldSize: number = 0;
  protected totalFieldCount: number = 0;
  protected totalFileSize: number = 0;
  protected flushing: number = 0;
  protected backpressure: boolean = false;
  protected writeCbs: Fn[] = [];
  protected emitQueue: string[] = [];

  constructor(options?: FormOptions) {
    super();
    const opts = options || {};

    this.autoFields = !!opts.autoFields;
    this.autoFiles = !!opts.autoFiles;

    this.maxFields = opts.maxFields || 1000;
    this.maxFieldsSize = opts.maxFieldsSize || 2 * 1024 * 1024;
    this.maxFilesSize = opts.maxFilesSize || Infinity;
    this.uploadDir = opts.uploadDir || os.tmpdir();
    this.encoding = opts.encoding || 'utf8';

    this.on('newListener', (eventName) => {
      if (eventName == 'file') {
        this.autoFiles = true;
      } else if (eventName == 'field') {
        this.autoFields = true;
      }
    });
  }

  parse(req: IncomingMessage, cb: Fn) {
    const self = this;
    let called = false;
    let waitend = true;

    if (cb) {
      // if the user supplies a callback, this implies autoFields and autoFiles
      self.autoFields = true;
      self.autoFiles = true;

      // wait for request to end before calling cb
      const end = (done: Fn) => {
        if (called) return;

        called = true;

        // wait for req events to fire
        process.nextTick(() => {
          if (waitend && req.readable) {
            // dump rest of request
            req.resume();
            req.once('end', done);
            return;
          }

          done();
        });
      };

      const fields: ObjectAny = {};
      const files: ObjectAny = {};
      self.on('error', (err) => {
        end(() => {
          cb(err);
        });
      });
      self.on('field', (name, value) => {
        const fieldsArray = fields[name] || (fields[name] = []);
        fieldsArray.push(value);
      });
      self.on('file', (name, file) => {
        const filesArray = files[name] || (files[name] = []);
        filesArray.push(file);
      });
      self.on('close', () => {
        end(() => {
          cb(null, fields, files);
        });
      });
    }

    self.handleError = handleError;
    self.bytesExpected = getBytesExpected(req.headers);

    req.on('end', onReqEnd);
    req.on('error', (err) => {
      waitend = false;
      handleError(err);
    });
    req.on('aborted', onReqAborted);

    const state = req._readableState;
    if (req._decoder || (state && (state.encoding || state.decoder))) {
      // this is a binary protocol
      // if an encoding is set, input is likely corrupted
      validationError(new Error('request encoding must not be set'));
      return;
    }

    const contentType = req.headers['content-type'];
    if (!contentType) {
      validationError(createError(415, 'missing content-type header'));
      return;
    }

    let m = CONTENT_TYPE_RE.exec(contentType);
    if (!m) {
      validationError(createError(415, 'unsupported content-type'));
      return;
    }

    let boundary;
    CONTENT_TYPE_PARAM_RE.lastIndex = m.index + m[0].length - 1;
    while ((m = CONTENT_TYPE_PARAM_RE.exec(contentType))) {
      if (m[1].toLowerCase() !== 'boundary') continue;
      boundary = m[2] || m[3];
      break;
    }

    if (!boundary) {
      validationError(createError(400, 'content-type missing boundary'));
      return;
    }

    setUpParser(self, boundary);
    req.pipe(self);

    function onReqAborted() {
      waitend = false;
      self.emit('aborted');
      handleError(new Error('Request aborted'));
    }

    function onReqEnd() {
      waitend = false;
    }

    function handleError(err) {
      const first = !self.error;
      if (first) {
        self.error = err;
        req.removeListener('aborted', onReqAborted);
        req.removeListener('end', onReqEnd);
        if (self.destStream) {
          errorEventQueue(self, self.destStream, err);
        }
      }

      cleanupOpenFiles(self);

      if (first) {
        self.emit('error', err);
      }
    }

    function validationError(err) {
      // handle error on next tick for event listeners to attach
      process.nextTick(handleError.bind(null, err));
    }
  }

  _write(buffer, encoding, cb) {
    if (this.error) return;

    const self = this;
    let i = 0;
    const len = buffer.length;
    let prevIndex = self.index;
    let index = self.index;
    let state = self.state;
    const lookbehind = self.lookbehind;
    const boundary = self.boundary;
    const boundaryChars = self.boundaryChars;
    const boundaryLength = self.boundary.length;
    const boundaryEnd = boundaryLength - 1;
    const bufferLength = buffer.length;
    let c;
    let cl;

    for (i = 0; i < len; i++) {
      c = buffer[i];
      switch (state) {
        case START:
          index = 0;
          state = START_BOUNDARY;
        /* falls through */
        case START_BOUNDARY:
          if (index === boundaryLength - 2 && c === HYPHEN) {
            index = 1;
            state = CLOSE_BOUNDARY;
            break;
          } else if (index === boundaryLength - 2) {
            if (c !== CR) return self.handleError(createError(400, 'Expected CR Received ' + c));
            index++;
            break;
          } else if (index === boundaryLength - 1) {
            if (c !== LF) return self.handleError(createError(400, 'Expected LF Received ' + c));
            index = 0;
            self.onParsePartBegin();
            state = HEADER_FIELD_START;
            break;
          }

          if (c !== boundary[index + 2]) index = -2;
          if (c === boundary[index + 2]) index++;
          break;
        case HEADER_FIELD_START:
          state = HEADER_FIELD;
          self.headerFieldMark = i;
          index = 0;
        /* falls through */
        case HEADER_FIELD:
          if (c === CR) {
            self.headerFieldMark = null;
            state = HEADERS_ALMOST_DONE;
            break;
          }

          index++;
          if (c === HYPHEN) break;

          if (c === COLON) {
            if (index === 1) {
              // empty header field
              self.handleError(createError(400, 'Empty header field'));
              return;
            }
            self.onParseHeaderField(buffer.slice(self.headerFieldMark, i));
            self.headerFieldMark = null;
            state = HEADER_VALUE_START;
            break;
          }

          cl = lower(c);
          if (cl < A || cl > Z) {
            self.handleError(createError(400, 'Expected alphabetic character, received ' + c));
            return;
          }
          break;
        case HEADER_VALUE_START:
          if (c === SPACE) break;

          self.headerValueMark = i;
          state = HEADER_VALUE;
        /* falls through */
        case HEADER_VALUE:
          if (c === CR) {
            self.onParseHeaderValue(buffer.slice(self.headerValueMark, i));
            self.headerValueMark = null;
            self.onParseHeaderEnd();
            state = HEADER_VALUE_ALMOST_DONE;
          }
          break;
        case HEADER_VALUE_ALMOST_DONE:
          if (c !== LF) return self.handleError(createError(400, 'Expected LF Received ' + c));
          state = HEADER_FIELD_START;
          break;
        case HEADERS_ALMOST_DONE:
          if (c !== LF) return self.handleError(createError(400, 'Expected LF Received ' + c));
          const err = self.onParseHeadersEnd(i + 1);
          if (err) return self.handleError(err);
          state = PART_DATA_START;
          break;
        case PART_DATA_START:
          state = PART_DATA;
          self.partDataMark = i;
        /* falls through */
        case PART_DATA:
          prevIndex = index;

          if (index === 0) {
            // boyer-moore derrived algorithm to safely skip non-boundary data
            i += boundaryEnd;
            while (i < bufferLength && !(buffer[i] in boundaryChars)) {
              i += boundaryLength;
            }
            i -= boundaryEnd;
            c = buffer[i];
          }

          if (index < boundaryLength) {
            if (boundary[index] === c) {
              if (index === 0) {
                self.onParsePartData(buffer.slice(self.partDataMark, i));
                self.partDataMark = null;
              }
              index++;
            } else {
              index = 0;
            }
          } else if (index === boundaryLength) {
            index++;
            if (c === CR) {
              // CR = part boundary
              self.partBoundaryFlag = true;
            } else if (c === HYPHEN) {
              index = 1;
              state = CLOSE_BOUNDARY;
              break;
            } else {
              index = 0;
            }
          } else if (index - 1 === boundaryLength) {
            if (self.partBoundaryFlag) {
              index = 0;
              if (c === LF) {
                self.partBoundaryFlag = false;
                self.onParsePartEnd();
                self.onParsePartBegin();
                state = HEADER_FIELD_START;
                break;
              }
            } else {
              index = 0;
            }
          }

          if (index > 0) {
            // when matching a possible boundary, keep a lookbehind reference
            // in case it turns out to be a false lead
            lookbehind[index - 1] = c;
          } else if (prevIndex > 0) {
            // if our boundary turned out to be rubbish, the captured lookbehind
            // belongs to partData
            self.onParsePartData(lookbehind.slice(0, prevIndex));
            prevIndex = 0;
            self.partDataMark = i;

            // reconsider the current character even so it interrupted the sequence
            // it could be the beginning of a new sequence
            i--;
          }

          break;
        case CLOSE_BOUNDARY:
          if (c !== HYPHEN) return self.handleError(createError(400, 'Expected HYPHEN Received ' + c));
          if (index === 1) {
            self.onParsePartEnd();
            state = END;
          } else if (index > 1) {
            return self.handleError(new Error('Parser has invalid state.'));
          }
          index++;
          break;
        case END:
          break;
        default:
          self.handleError(new Error('Parser has invalid state.'));
          return;
      }
    }

    if (self.headerFieldMark != null) {
      self.onParseHeaderField(buffer.slice(self.headerFieldMark));
      self.headerFieldMark = 0;
    }
    if (self.headerValueMark != null) {
      self.onParseHeaderValue(buffer.slice(self.headerValueMark));
      self.headerValueMark = 0;
    }
    if (self.partDataMark != null) {
      self.onParsePartData(buffer.slice(self.partDataMark));
      self.partDataMark = 0;
    }

    self.index = index;
    self.state = state;

    self.bytesReceived += buffer.length;
    self.emit('progress', self.bytesReceived, self.bytesExpected);

    if (self.backpressure) {
      self.writeCbs.push(cb);
    } else {
      cb();
    }
  }

  onParsePartBegin() {
    clearPartVars(this);
  }

  onParseHeaderField(b) {
    this.headerField += this.headerFieldDecoder.write(b);
  }

  onParseHeaderValue(b) {
    this.headerValue += this.headerValueDecoder.write(b);
  }

  onParseHeaderEnd() {
    this.headerField = this.headerField.toLowerCase();
    this.partHeaders[this.headerField] = this.headerValue;

    let m;
    if (this.headerField === 'content-disposition') {
      if ((m = this.headerValue.match(/\bname="([^"]+)"/i))) {
        this.partName = m[1];
      }
      this.partFilename = parseFilename(this.headerValue);
    } else if (this.headerField === 'content-transfer-encoding') {
      this.partTransferEncoding = this.headerValue.toLowerCase();
    }

    this.headerFieldDecoder = new StringDecoder(this.encoding);
    this.headerField = '';
    this.headerValueDecoder = new StringDecoder(this.encoding);
    this.headerValue = '';
  }

  onParsePartData(b) {
    if (this.partTransferEncoding === 'base64') {
      this.backpressure = !this.destStream.write(b.toString('ascii'), 'base64');
    } else {
      this.backpressure = !this.destStream.write(b);
    }
  }

  onParsePartEnd() {
    if (this.destStream) {
      flushWriteCbs(this);
      const s = this.destStream;
      process.nextTick(() => {
        s.end();
      });
    }
    clearPartVars(this);
  }

  onParseHeadersEnd(offset) {
    const self = this;
    switch (self.partTransferEncoding) {
      case 'binary':
      case '7bit':
      case '8bit':
        self.partTransferEncoding = 'binary';
        break;

      case 'base64':
        break;
      default:
        return createError(400, 'unknown transfer-encoding: ' + self.partTransferEncoding);
    }

    self.totalFieldCount += 1;
    if (self.totalFieldCount > self.maxFields) {
      return createError(413, 'maxFields ' + self.maxFields + ' exceeded.');
    }

    self.destStream = new stream.PassThrough();
    self.destStream.on('drain', () => {
      flushWriteCbs(self);
    });
    self.destStream.headers = self.partHeaders;
    self.destStream.name = self.partName;
    self.destStream.filename = self.partFilename;
    self.destStream.byteOffset = self.bytesReceived + offset;
    const partContentLength = self.destStream.headers['content-length'];
    self.destStream.byteCount = partContentLength
      ? parseInt(partContentLength, 10)
      : self.bytesExpected
      ? self.bytesExpected - self.destStream.byteOffset - self.boundary.length - LAST_BOUNDARY_SUFFIX_LEN
      : undefined;

    if (self.destStream.filename == null && self.autoFields) {
      handleField(self, self.destStream);
    } else if (self.destStream.filename != null && self.autoFiles) {
      handleFile(self, self.destStream);
    } else {
      handlePart(self, self.destStream);
    }
  }
}
