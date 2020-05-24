import fs = require('fs');
import os = require('os');
import { PassThrough, Readable } from 'stream';
import { Writable } from 'stream';
import { EventEmitter } from 'events';
import { IncomingHttpHeaders } from 'http';
import { StringDecoder } from 'string_decoder';
import createError = require('http-errors');
const fdSlicer = require('fd-slicer');
import uid = require('uid-safe');
import path = require('path');

import {
  FormOptions,
  Fn,
  ObjectAny,
  HoldEmitQueueItem,
  PassThroughExt,
  OpenedFile,
  PublicFile,
  NodeReq,
  PartEvent,
  FormFile,
} from './types';

const START = 0;
const END = 11;
const FILE_EXT_RE = /(\.[_\-a-zA-Z0-9]{0,16})[\S\s]*/;

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
  protected encoding: BufferEncoding;
  protected openedFiles: OpenedFile[] = [];
  protected totalFieldSize: number = 0;
  protected totalFieldCount: number = 0;
  protected totalFileSize: number = 0;
  protected flushing: number = 0;
  protected backpressure: boolean = false;
  protected writeCbs: Fn[] = [];
  protected emitQueue: HoldEmitQueueItem[] = [];
  protected destStream: PassThroughExt;
  protected req: NodeReq;
  protected waitend: boolean;
  protected boundOnReqAborted: Fn;
  protected boundOnReqEnd: Fn;
  protected partTransferEncoding: string;
  protected partHeaders: IncomingHttpHeaders;
  protected headerFieldDecoder: StringDecoder;
  protected headerValueDecoder: StringDecoder;
  protected headerField: string;
  protected headerValue: string;
  protected partFilename: string;
  protected partName: string;
  protected boundary: Buffer;
  protected index: number;
  protected partDataMark: number;
  protected headerValueMark: number;
  protected headerFieldMark: number;
  protected partBoundaryFlag: boolean;
  protected state: number;
  protected lookbehind: Buffer;
  protected boundaryChars: { [x: string]: boolean };

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

  /**
   * Parses an incoming node.js `request` containing form data. This will cause
   * `form` to emit events based off the incoming request.
   */
  parse(req: NodeReq, cb?: (err?: Error & { statusCode?: number }, fields?: ObjectAny, files?: ObjectAny) => void) {
    this.req = req;
    const self = this;
    let called = false;
    this.waitend = true;

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
          if (this.waitend && this.req.readable) {
            // dump rest of request
            this.req.resume();
            this.req.once('end', done);
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

    this.bytesExpected = this.getBytesExpected(this.req.headers);

    this.boundOnReqEnd = this.onReqEnd.bind(this);
    this.req.on('end', this.boundOnReqEnd);

    this.req.on('error', (err: Error) => {
      this.waitend = false;
      this.handleError(err);
    });

    this.boundOnReqAborted = this.onReqAborted.bind(this);
    this.req.on('aborted', this.boundOnReqAborted);

    const state = this.req._readableState;
    if (this.req._decoder || (state && (state.encoding || state.decoder))) {
      // this is a binary protocol
      // if an encoding is set, input is likely corrupted
      validationError(new Error('request encoding must not be set'));
      return;
    }

    const contentType = this.req.headers['content-type'];
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

    this.setUpParser(boundary);
    this.req.pipe(this);

    function validationError(err: Error) {
      // handle error on next tick for event listeners to attach
      process.nextTick(self.handleError.bind(self, err));
    }
  }

  /**
   * Unless you supply a callback to `form.parse`, you definitely want to handle
   * this event. Otherwise your server *will* crash when users submit bogus
   * multipart requests!
   *
   * Only one `error` event can ever be emitted, and if an `error` event is
   * emitted, then `close` will not be emitted.
   *
   * If the error would correspond to a certain HTTP response code, the `err` object
   * will have a `statusCode` property with the value of the suggested HTTP response
   * code to send back.
   *
   * Note that an `error` event will be emitted both from the `form` and from the
   * current `part`.
   */
  on(event: 'error', listener: (err: Error & { statusCode?: number }) => void): this;
  /**
   * Emitted when a part is encountered in the request.
   * Parts for fields are not emitted when `autoFields` is on, and likewise parts
   * for files are not emitted when `autoFiles` is on.
   *
   * `part` emits 'error' events! Make sure you handle them.
   *
   * You *must* act on the part by reading it.
   * If you want to ignore it, just call `part.resume()`.
   */
  on(event: 'part', listener: (part: PartEvent) => void): this;
  /**
   * Emitted when the request is aborted. This event will be followed shortly
   * by an `error` event. In practice you do not need to handle this event.
   */
  on(event: 'aborted', listener: () => void): this;
  /**
   * Emitted when a chunk of data is received for the form. The `bytesReceived`
   * argument contains the total count of bytes received for this form so far. The
   * `bytesExpected` argument contains the total expected bytes if known, otherwise
   * `null`.
   */
  on(event: 'progress', listener: (bytesReceived?: number, bytesExpected?: number) => void): this;
  /**
   * Emitted after all parts have been parsed and emitted. Not emitted if an `error`
   * event is emitted.
   *
   * If you have `autoFiles` on, this is not fired until all the data has been
   * flushed to disk and the file handles have been closed.
   *
   * This is typically when you would send your response.
   */
  on(event: 'close', listener: () => void): this;
  /**
   * **By default multiparty will not touch your hard drive.** But if you add this
   * listener, multiparty automatically sets `form.autoFiles` to `true` and will
   * stream uploads to disk for you.
   *
   * **The max bytes accepted per request can be specified with `maxFilesSize`.**
   */
  on(event: 'file', listener: (name?: string, file?: FormFile) => void): this;
  /**
   * - `name` - field name.
   * - `value` - string field value.
   */
  on(event: 'field', listener: (name?: string, value?: string) => void): this;
  on(event: 'drain', listener: () => void): this;
  on(event: 'finish', listener: () => void): this;
  on(event: 'resume', listener: () => void): this;
  on(event: 'pipe', listener: (src: Readable) => void): this;
  on(event: 'unpipe', listener: (src: Readable) => void): this;
  on(event: 'newListener', listener: (event: string) => void): this;
  on(event: string, listener: (...args: any[]) => void) {
    return super.on(event, listener);
  }

  _write(buffer: Buffer, encoding: string, cb: Fn) {
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

          cl = this.lower(c);
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
    this.clearPartVars();
  }

  onParseHeaderField(b: Buffer) {
    this.headerField += this.headerFieldDecoder.write(b);
  }

  onParseHeaderValue(b: Buffer) {
    this.headerValue += this.headerValueDecoder.write(b);
  }

  onParseHeaderEnd() {
    this.headerField = this.headerField.toLowerCase();
    this.partHeaders[this.headerField] = this.headerValue;

    if (this.headerField == 'content-disposition') {
      const m = this.headerValue.match(/\bname="([^"]+)"/i);

      if (m) {
        this.partName = m[1];
      }
      this.partFilename = this.parseFilename(this.headerValue);
    } else if (this.headerField == 'content-transfer-encoding') {
      this.partTransferEncoding = this.headerValue.toLowerCase();
    }

    this.headerFieldDecoder = new StringDecoder(this.encoding);
    this.headerField = '';
    this.headerValueDecoder = new StringDecoder(this.encoding);
    this.headerValue = '';
  }

  onParsePartData(b: Buffer) {
    if (this.partTransferEncoding == 'base64') {
      this.backpressure = !this.destStream.write(b.toString('ascii'), 'base64');
    } else {
      this.backpressure = !this.destStream.write(b);
    }
  }

  onParsePartEnd() {
    if (this.destStream) {
      this.flushWriteCbs();
      const s = this.destStream;
      process.nextTick(() => {
        s.end();
      });
    }
    this.clearPartVars();
  }

  onParseHeadersEnd(offset: number) {
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
      this.flushWriteCbs();
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
      this.handleField(this.destStream);
    } else if (this.destStream.filename != null && this.autoFiles) {
      this.handleFile(this.destStream);
    } else {
      this.handlePart(this.destStream);
    }
  }

  protected onReqEnd() {
    this.waitend = false;
  }

  protected handleError(err: Error) {
    const first = !this.error;
    if (first) {
      this.error = err;
      this.req.removeListener('aborted', this.boundOnReqAborted);
      this.req.removeListener('end', this.boundOnReqEnd);
      if (this.destStream) {
        this.errorEventQueue(this.destStream, err);
      }
    }

    this.cleanupOpenFiles();

    if (first) {
      this.emit('error', err);
    }
  }

  protected onReqAborted() {
    this.waitend = false;
    this.emit('aborted');
    this.handleError(new Error('Request aborted'));
  }

  protected clearPartVars() {
    this.partHeaders = {};
    this.partName = null;
    this.partFilename = null;
    this.partTransferEncoding = 'binary';
    this.destStream = null;

    this.headerFieldDecoder = new StringDecoder(this.encoding);
    this.headerField = '';
    this.headerValueDecoder = new StringDecoder(this.encoding);
    this.headerValue = '';
  }

  protected parseFilename(headerValue: string) {
    let m = headerValue.match(/\bfilename="(.*?)"($|; )/i);
    if (!m) {
      m = headerValue.match(/\bfilename\*=utf-8''(.*?)($|; )/i);
      if (m) {
        m[1] = decodeURI(m[1]);
      } else {
        return;
      }
    }

    let filename = m[1];
    filename = filename.replace(/%22|\\"/g, '"');
    filename = filename.replace(/&#([\d]{4});/g, (m, code) => {
      return String.fromCharCode(code);
    });
    return filename.substr(filename.lastIndexOf('\\') + 1);
  }

  protected lower(c: number) {
    return c | 0x20;
  }

  protected flushWriteCbs() {
    this.writeCbs.forEach((cb) => {
      process.nextTick(cb);
    });
    this.writeCbs = [];
    this.backpressure = false;
  }

  protected getBytesExpected(headers: IncomingHttpHeaders) {
    const contentLength = headers['content-length'];
    if (contentLength) {
      return parseInt(contentLength, 10);
    } else if (headers['transfer-encoding'] == null) {
      return 0;
    } else {
      return null;
    }
  }

  protected beginFlush() {
    this.flushing += 1;
  }

  protected endFlush() {
    this.flushing -= 1;

    if (this.flushing < 0) {
      // if this happens this is a critical bug in multiparty and this stack trace
      // will help us figure it out.
      this.handleError(new Error('unexpected endFlush'));
      return;
    }

    if (this.flushing > 0 || this.error) return;

    // go through the emit queue in case any field, file, or part events are
    // waiting to be emitted
    this.holdEmitQueue()(() => {
      // nextTick because the user is listening to part 'end' events and we are
      // using part 'end' events to decide when to emit 'close'. we add our 'end'
      // handler before the user gets a chance to add theirs. So we make sure
      // their 'end' event fires before we emit the 'close' event.
      // this is covered by test/standalone/test-issue-36
      process.nextTick(() => {
        this.emit('close');
      });
    });
  }

  protected cleanupOpenFiles() {
    this.openedFiles.forEach((internalFile) => {
      // since fd slicer autoClose is true, destroying the only write stream
      // is guaranteed by the API to close the fd
      internalFile.ws.destroy();

      fs.unlink(internalFile.publicFile.path, (err) => {
        if (err) this.handleError(err);
      });
    });
    this.openedFiles = [];
  }

  protected holdEmitQueue(eventEmitter?: EventEmitter) {
    const item: HoldEmitQueueItem = { cb: null, ee: eventEmitter, err: null };
    this.emitQueue.push(item);
    return (cb: Fn) => {
      item.cb = cb;
      while (this.emitQueue.length > 0 && this.emitQueue[0].cb) {
        const item = this.emitQueue.shift();

        // invoke the callback
        item.cb();

        if (item.err) {
          // emit the delayed error
          item.ee.emit('error', item.err);
        }
      }
    };
  }

  protected errorEventQueue(eventEmitter: EventEmitter, err: Error) {
    const items = this.emitQueue.filter((item) => {
      return item.ee === eventEmitter;
    });

    if (items.length === 0) {
      eventEmitter.emit('error', err);
      return;
    }

    items.forEach((item) => {
      item.err = err;
    });
  }

  protected handlePart(partStream: PassThroughExt) {
    this.beginFlush();
    const emitAndReleaseHold = this.holdEmitQueue(partStream);
    partStream.on('end', () => {
      this.endFlush();
    });
    emitAndReleaseHold(() => {
      this.emit('part', partStream);
    });
  }

  protected handleFile(fileStream: PassThroughExt) {
    if (this.error) return;
    const publicFile: PublicFile = {
      fieldName: fileStream.name,
      originalFilename: fileStream.filename,
      path: uploadPath(this.uploadDir, fileStream.filename),
      headers: fileStream.headers,
      size: 0,
    };
    const internalFile: OpenedFile = {
      publicFile,
      ws: null,
    };
    this.beginFlush(); // flush to write stream
    const emitAndReleaseHold = this.holdEmitQueue(fileStream);
    fileStream.on('error', (err) => {
      this.handleError(err);
    });
    fs.open(publicFile.path, 'wx', (err1, fd) => {
      if (err1) return this.handleError(err1);
      const slicer = fdSlicer.createFromFd(fd, { autoClose: true });

      // end option here guarantees that no more than that amount will be written
      // or else an error will be emitted
      internalFile.ws = slicer.createWriteStream({ end: this.maxFilesSize - this.totalFileSize });

      // if an error ocurred while we were waiting for fs.open we handle that
      // cleanup now
      this.openedFiles.push(internalFile);
      if (this.error) return this.cleanupOpenFiles();

      let prevByteCount = 0;
      internalFile.ws.on('error', (err2: Error & { code: string }) => {
        this.handleError(err2.code === 'ETOOBIG' ? createError(413, err2.message, { code: err2.code }) : err2);
      });
      internalFile.ws.on('progress', () => {
        publicFile.size = internalFile.ws.bytesWritten;
        const delta = publicFile.size - prevByteCount;
        this.totalFileSize += delta;
        prevByteCount = publicFile.size;
      });
      slicer.on('close', () => {
        if (this.error) return;
        emitAndReleaseHold(() => {
          this.emit('file', fileStream.name, publicFile);
        });
        this.endFlush();
      });
      fileStream.pipe(internalFile.ws);
    });

    function uploadPath(baseDir: string, filename: string) {
      const ext = path.extname(filename).replace(FILE_EXT_RE, '$1');
      const name = uid.sync(18) + ext;
      return path.join(baseDir, name);
    }
  }

  protected handleField(fieldStream: PassThroughExt) {
    let value = '';
    const decoder = new StringDecoder(this.encoding);

    this.beginFlush();
    const emitAndReleaseHold = this.holdEmitQueue(fieldStream);
    fieldStream.on('error', (err) => {
      this.handleError(err);
    });
    fieldStream.on('readable', () => {
      const buffer = fieldStream.read();
      if (!buffer) return;

      this.totalFieldSize += buffer.length;
      if (this.totalFieldSize > this.maxFieldsSize) {
        this.handleError(createError(413, 'maxFieldsSize ' + this.maxFieldsSize + ' exceeded'));
        return;
      }
      value += decoder.write(buffer);
    });

    fieldStream.on('end', () => {
      emitAndReleaseHold(() => {
        this.emit('field', fieldStream.name, value);
      });
      this.endFlush();
    });
  }

  protected setUpParser(boundary: string) {
    this.boundary = Buffer.alloc(boundary.length + 4);
    this.boundary.write('\r\n--', 0, boundary.length + 4, 'ascii');
    this.boundary.write(boundary, 4, boundary.length, 'ascii');
    this.lookbehind = Buffer.alloc(this.boundary.length + 8);
    this.state = START;
    this.boundaryChars = {};
    for (let i = 0; i < this.boundary.length; i++) {
      this.boundaryChars[this.boundary[i]] = true;
    }

    this.index = null;
    this.partBoundaryFlag = false;

    this.beginFlush();
    this.on('finish', () => {
      if (this.state !== END) {
        this.handleError(createError(400, 'stream ended unexpectedly'));
      }
      this.endFlush();
    });
  }
}
