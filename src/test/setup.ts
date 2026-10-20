import { Blob as NodeBlob } from 'node:buffer';
import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';

// jsdom's Blob cannot be structured-cloned by fake-indexeddb (real browsers store Blobs fine).
// Node's native Blob can, and it implements text()/arrayBuffer()/size/type like a browser's.
globalThis.Blob = NodeBlob as unknown as typeof Blob;
