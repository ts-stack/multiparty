import { PassThrough } from 'stream';
import { EventEmitter } from 'events';
import { IncomingHttpHeaders, IncomingMessage } from 'http';
import fs = require('fs');
import { LimitStream } from './limit-stream';

export class FormOptions {
  /**
   * Sets encoding for the incoming form fields. Defaults to `utf8`.
   */
  encoding?: BufferEncoding;
  /**
   * Limits the amount of memory all fields (not files) can allocate in bytes.
   * If this value is exceeded, an `error` event is emitted.
   * The default size is 2MB.
   */
  maxFieldsSize?: number;
  /**
   * Limits the number of fields that will be parsed before emitting an `error` event.
   * A file counts as a field in this case. Defaults to 1000.
   */
  maxFields?: number;
  /**
   * Only relevant when `autoFiles` is `true`.
   * Limits the total bytes accepted for all files combined.
   * If this value is exceeded, an `error` event is emitted.
   * The default is `Infinity`.
   */
  maxFilesSize?: number;
  /**
   * Enables `field` events and disables `part` events for fields.
   * This is automatically set to `true` if you add a `field` listener.
   */
  autoFields?: boolean;
  /**
   * Enables `file` events and disables `part` events for files.
   * This is automatically set to `true` if you add a `file` listener.
   */
  autoFiles?: boolean;
  /**
   * Only relevant when `autoFiles` is `true`.
   * The directory for placing file uploads in.
   * You can move them later using `fs.rename()`.
   * Defaults to `os.tmpdir()`.
   */
  uploadDir?: string;
}

export type Fn = (...args: any[]) => any;
export interface ObjectAny {
  [key: string]: any;
}

export interface HoldEmitQueueItem {
  cb: Fn;
  ee: EventEmitter;
  err: Error;
}

export interface PassThroughExt extends PassThrough {
  name: string;
  headers: IncomingHttpHeaders;
  filename: string;
  byteOffset: number;
  byteCount: number;
}

export interface OpenedFile {
  publicFile: PublicFile;
  ls: LimitStream;
  ws: fs.WriteStream;
}

export interface PublicFile {
  fieldName: string;
  originalFilename: string;
  path: string;
  headers: IncomingHttpHeaders;
  size: number;
}

export interface ReadableState {
  objectMode: boolean;
  highWaterMark: number;
  buffer: Buffer;
  length: number;
  pipes: this;
  pipesCount: number;
  flowing: boolean;
  ended: boolean;
  endEmitted: boolean;
  reading: boolean;
  sync: boolean;
  needReadable: true;
  emittedReadable: boolean;
  readableListening: boolean;
  resumeScheduled: boolean;
  defaultEncoding: BufferEncoding;
  ranOut: boolean;
  awaitDrain: number;
  readingMore: boolean;
  decoder: null;
  encoding: null;
}

/**
 * @todo Search for real the type.
 */
export type NodeReq = IncomingMessage & { _readableState?: ReadableState } & { _decoder?: any };

export interface PartEvent extends ReadableStream {
  /**
   * The headers for this part. For example, you may be interested in `content-type`.
   */
  headers: IncomingHttpHeaders;
  /**
   * The field name for this part.
   */
  name: string;
  /**
   * Only if the part is an incoming file.
   */
  filename: string;
  /**
   * The byte offset of this part in the request body.
   */
  byteOffset: number;
  /**
   * Assuming that this is the last part in the request, this is the size of this part in bytes.
   * You could use this, for example, to set the `Content-Length` header if uploading to S3.
   * If the part had a `Content-Length` header then that value is used here instead.
   */
  byteCount: number;
  on(event: 'error', listener: (err: Error & { statusCode?: number }) => void): this;
  resume(): this;
}

export interface FormFile {
  /**
   * Same as `name` - the field name for this file.
   */
  fieldName: string;
  /**
   * The filename that the user reports for the file.
   */
  originalFilename: string;
  /**
   * The absolute path of the uploaded file on disk.
   */
  path: string;
  /**
   * The HTTP headers that were sent along with this file.
   */
  headers: IncomingHttpHeaders;
  /**
   * Size of the file in bytes.
   */
  size: number;
}
