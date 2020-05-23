import os = require('os');
import createError = require('http-errors');
import { PassThrough } from 'stream';
import { Writable } from 'stream';
import { IncomingMessage, IncomingHttpHeaders } from 'http';
import { StringDecoder } from 'string_decoder';

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

export interface PassThroughExt extends PassThrough {
  name: string;
  headers: IncomingHttpHeaders;
  filename: string;
  byteOffset: number;
  byteCount: number;
}

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
  protected req: IncomingMessage;
  protected waitend: boolean = true;
  protected destStream: PassThroughExt;

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
    this.req = req;
    let called = false;
    const self = this;

    if (cb) {
      // if the user supplies a callback, this implies autoFields and autoFiles
      this.autoFields = true;
      this.autoFiles = true;

      // wait for request to end before calling cb
      const end = (done: Fn) => {
        if (called) return;

        called = true;

        // wait for req events to fire
        process.nextTick(() => {
          if (this.waitend && req.readable) {
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
      this.on('error', (err) => {
        end(() => {
          cb(err);
        });
      });
      this.on('field', (name, value) => {
        const fieldsArray = fields[name] || (fields[name] = []);
        fieldsArray.push(value);
      });
      this.on('file', (name, file) => {
        const filesArray = files[name] || (files[name] = []);
        filesArray.push(file);
      });
      this.on('close', () => {
        end(() => {
          cb(null, fields, files);
        });
      });
    }

    this.bytesExpected = getBytesExpected(req.headers);

    req.on('end', this.onReqEnd.bind(this));
    req.on('error', (err) => {
      this.waitend = false;
      this.handleError(err);
    });
    req.on('aborted', this.onReqAborted.bind(this));

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

    setUpParser(this, boundary);
    req.pipe(this);

    function validationError(err: Error) {
      // handle error on next tick for event listeners to attach
      process.nextTick(self.handleError.bind(self, err));
    }
  }

  _write(buffer: Buffer, encoding, cb) {
    if (this.error) return;

    let i = 0;
    const len = buffer.length;
    let prevIndex = this.index;
    let index = this.index;
    let state = this.state;
    const lookbehind = this.lookbehind;
    const boundary = this.boundary;
    const boundaryChars = this.boundaryChars;
    const boundaryLength = this.boundary.length;
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
            if (c !== CR) return this.handleError(createError(400, 'Expected CR Received ' + c));
            index++;
            break;
          } else if (index === boundaryLength - 1) {
            if (c !== LF) return this.handleError(createError(400, 'Expected LF Received ' + c));
            index = 0;
            this.onParsePartBegin();
            state = HEADER_FIELD_START;
            break;
          }

          if (c !== boundary[index + 2]) index = -2;
          if (c === boundary[index + 2]) index++;
          break;
        case HEADER_FIELD_START:
          state = HEADER_FIELD;
          this.headerFieldMark = i;
          index = 0;
        /* falls through */
        case HEADER_FIELD:
          if (c === CR) {
            this.headerFieldMark = null;
            state = HEADERS_ALMOST_DONE;
            break;
          }

          index++;
          if (c === HYPHEN) break;

          if (c === COLON) {
            if (index === 1) {
              // empty header field
              this.handleError(createError(400, 'Empty header field'));
              return;
            }
            this.onParseHeaderField(buffer.slice(this.headerFieldMark, i));
            this.headerFieldMark = null;
            state = HEADER_VALUE_START;
            break;
          }

          cl = lower(c);
          if (cl < A || cl > Z) {
            this.handleError(createError(400, 'Expected alphabetic character, received ' + c));
            return;
          }
          break;
        case HEADER_VALUE_START:
          if (c === SPACE) break;

          this.headerValueMark = i;
          state = HEADER_VALUE;
        /* falls through */
        case HEADER_VALUE:
          if (c === CR) {
            this.onParseHeaderValue(buffer.slice(this.headerValueMark, i));
            this.headerValueMark = null;
            this.onParseHeaderEnd();
            state = HEADER_VALUE_ALMOST_DONE;
          }
          break;
        case HEADER_VALUE_ALMOST_DONE:
          if (c !== LF) return this.handleError(createError(400, 'Expected LF Received ' + c));
          state = HEADER_FIELD_START;
          break;
        case HEADERS_ALMOST_DONE:
          if (c !== LF) return this.handleError(createError(400, 'Expected LF Received ' + c));
          const err = this.onParseHeadersEnd(i + 1);
          if (err) return this.handleError(err);
          state = PART_DATA_START;
          break;
        case PART_DATA_START:
          state = PART_DATA;
          this.partDataMark = i;
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
                this.onParsePartData(buffer.slice(this.partDataMark, i));
                this.partDataMark = null;
              }
              index++;
            } else {
              index = 0;
            }
          } else if (index === boundaryLength) {
            index++;
            if (c === CR) {
              // CR = part boundary
              this.partBoundaryFlag = true;
            } else if (c === HYPHEN) {
              index = 1;
              state = CLOSE_BOUNDARY;
              break;
            } else {
              index = 0;
            }
          } else if (index - 1 === boundaryLength) {
            if (this.partBoundaryFlag) {
              index = 0;
              if (c === LF) {
                this.partBoundaryFlag = false;
                this.onParsePartEnd();
                this.onParsePartBegin();
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
            this.onParsePartData(lookbehind.slice(0, prevIndex));
            prevIndex = 0;
            this.partDataMark = i;

            // reconsider the current character even so it interrupted the sequence
            // it could be the beginning of a new sequence
            i--;
          }

          break;
        case CLOSE_BOUNDARY:
          if (c !== HYPHEN) return this.handleError(createError(400, 'Expected HYPHEN Received ' + c));
          if (index === 1) {
            this.onParsePartEnd();
            state = END;
          } else if (index > 1) {
            return this.handleError(new Error('Parser has invalid state.'));
          }
          index++;
          break;
        case END:
          break;
        default:
          this.handleError(new Error('Parser has invalid state.'));
          return;
      }
    }

    if (this.headerFieldMark != null) {
      this.onParseHeaderField(buffer.slice(this.headerFieldMark));
      this.headerFieldMark = 0;
    }
    if (this.headerValueMark != null) {
      this.onParseHeaderValue(buffer.slice(this.headerValueMark));
      this.headerValueMark = 0;
    }
    if (this.partDataMark != null) {
      this.onParsePartData(buffer.slice(this.partDataMark));
      this.partDataMark = 0;
    }

    this.index = index;
    this.state = state;

    this.bytesReceived += buffer.length;
    this.emit('progress', this.bytesReceived, this.bytesExpected);

    if (this.backpressure) {
      this.writeCbs.push(cb);
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
    switch (this.partTransferEncoding) {
      case 'binary':
      case '7bit':
      case '8bit':
        this.partTransferEncoding = 'binary';
        break;

      case 'base64':
        break;
      default:
        return createError(400, 'unknown transfer-encoding: ' + this.partTransferEncoding);
    }

    this.totalFieldCount += 1;
    if (this.totalFieldCount > this.maxFields) {
      return createError(413, 'maxFields ' + this.maxFields + ' exceeded.');
    }

    this.destStream = new PassThrough() as PassThroughExt;
    this.destStream.on('drain', () => {
      flushWriteCbs(this);
    });
    this.destStream.headers = this.partHeaders;
    this.destStream.name = this.partName;
    this.destStream.filename = this.partFilename;
    this.destStream.byteOffset = this.bytesReceived + offset;
    const partContentLength = this.destStream.headers['content-length'];
    this.destStream.byteCount = partContentLength
      ? parseInt(partContentLength, 10)
      : this.bytesExpected
      ? this.bytesExpected - this.destStream.byteOffset - this.boundary.length - LAST_BOUNDARY_SUFFIX_LEN
      : undefined;

    if (this.destStream.filename == null && this.autoFields) {
      handleField(this, this.destStream);
    } else if (this.destStream.filename != null && this.autoFiles) {
      handleFile(this, this.destStream);
    } else {
      handlePart(this, this.destStream);
    }
  }

  protected handleError(err: Error) {
    const first = !this.error;
    if (first) {
      this.error = err;
      this.req.removeListener('aborted', this.onReqAborted.bind(this));
      this.req.removeListener('end', this.onReqEnd.bind(this));
      if (this.destStream) {
        errorEventQueue(this, this.destStream, err);
      }
    }

    cleanupOpenFiles(this);

    if (first) {
      this.emit('error', err);
    }
  }

  protected onReqAborted() {
    this.waitend = false;
    this.emit('aborted');
    this.handleError(new Error('Request aborted'));
  }

  protected onReqEnd() {
    this.waitend = false;
  }
}
