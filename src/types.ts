import { EventEmitter } from 'events';

export class FormOptions {
  /**
   * Sets encoding for the incoming form fields. Defaults to `utf8`.
   */
  encoding?: BufferEncoding;
  /**
   * Limits the amount of memory all fields (not files) can allocate in bytes.
   * If this value is exceeded, an error event is emitted.
   * The default size is 2MB.
   */
  maxFieldsSize?: number;
  /**
   * Limits the number of fields that will be parsed before emitting an error event.
   * A file counts as a field in this case. Defaults to 1000.
   */
  maxFields?: number;
  /**
   * Only relevant when autoFiles is true.
   * Limits the total bytes accepted for all files combined.
   * If this value is exceeded, an error event is emitted.
   * The default is Infinity.
   */
  maxFilesSize?: number;
  /**
   * Enables field events and disables part events for fields.
   * This is automatically set to true if you add a field listener.
   */
  autoFields?: boolean;
  /**
   * Enables file events and disables part events for files.
   * This is automatically set to true if you add a file listener.
   */
  autoFiles?: boolean;
  /**
   * Only relevant when autoFiles is true.
   * The directory for placing file uploads in.
   * You can move them later using fs.rename().
   * Defaults to os.tmpdir().
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
