import assert from "node:assert/strict";
import { test } from "node:test";
import { indexObjects } from "../src/pdf-objects.ts";
import { streamDecryptor } from "../src/pdf-decrypt.ts";

/**
 * Known-answer files for the AES-256 handlers. pdf-decrypt.test.ts builds its encrypted files with the same reading of
 * the standard as the decryptor, so a shared mistake would pass there. These bytes were written once by that builder
 * and read back by poppler's pdftotext 26.x, which implements the handler on its own: `pdftotext r6-empty.pdf -` and
 * `pdftotext -upw 'pässword' r6-pw.pdf -` print "Secret AES text", a wrong password is refused. They are frozen here, so
 * the decryptor is held to poppler's reading and not to the builder's (tikajs-f301).
 */
const R6_EMPTY_PASSWORD = Buffer.from(
  "JVBERi0xLjcKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUg" +
  "L1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAg" +
  "UiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIg" +
  "Pj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA2NCA+PgpzdHJlYW0KByZFZIOiweD/Hj1ce5q52J5pRTR9smJ1geAu" +
  "SPtRL/Vvl7E5uJ498a1S2CEoQnSbvkiN/nMdXE9/+CB3aNQaKgplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0Zv" +
  "bnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago2IDAgb2JqCjw8IC9GaWx0ZXIgL1N0YW5k" +
  "YXJkIC9WIDUgL1IgNiAvTGVuZ3RoIDI1NiAvQ0YgPDwgL1N0ZENGIDw8IC9DRk0gL0FFU1YzIC9BdXRoRXZlbnQgL0RvY09wZW4g" +
  "L0xlbmd0aCAzMiA+PiA+PiAvU3RtRiAvU3RkQ0YgL1N0ckYgL1N0ZENGIC9QIC00IC9PIDwxMzMyNTE3MDhmYWVjZGVjMGIyYTQ5" +
  "Njg4N2E2YzVlNDAzMjI0MTYwN2Y5ZWJkZGNmYjFhMzk1ODc3OTZiNWQ0ZjMxMjMxNTA2ZjhlYWRjY2ViMGEyOTQ4Njc4NmE1YzQ+" +
  "IC9VIDwyZTdmMmU4NjI1MGI4ZDBkMDMxZTUyYzdjZjYyNWQzY2RmNTU5NTUxNGQ0YjFkYWQ1OWU0YTQ1YThkYmNjNzRjMGQyYzRi" +
  "NmE4OWE4YzdlNjExMzA0ZjZlOGRhY2NiZWE+IC9PRSA8MTczNjU1NzQ5M2IyZDFmMDBmMmU0ZDZjOGJhYWM5ZTgwNzI2NDU2NDgz" +
  "YTJjMWUwZmYxZTNkNWM3YjlhYjlkOD4gL1VFIDwwNDgxYjY5ZjAzMjI2NzJhMzJhODc1OGJjM2YzMWNlODk3MGY0NDg2Y2ZmM2I2" +
  "ZDE1M2ViZWVlYTE1MzRhYmVkPiAvUGVybXMgPDFkM2M1YjdhOTliOGQ3ZjYxNTM0NTM3MjkxYjBjZmVlPiA+PgplbmRvYmoKeHJl" +
  "ZgowIDcKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDEx" +
  "NSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzNTUgMDAwMDAgbiAKMDAwMDAwMDQyNSAwMDAwMCBuIAp0cmFp" +
  "bGVyCjw8IC9TaXplIDcgL1Jvb3QgMSAwIFIgL0VuY3J5cHQgNiAwIFIgL0lEIFs8MDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2Nk" +
  "ZGVlZmY+IDwwMDExMjIzMzQ0NTU2Njc3ODg5OWFhYmJjY2RkZWVmZj5dID4+CnN0YXJ0eHJlZgo5NzIKJSVFT0YK"
  , "base64");

const R6_PASSWORD = Buffer.from(
  "JVBERi0xLjcKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUg" +
  "L1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAg" +
  "UiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIg" +
  "Pj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA2NCA+PgpzdHJlYW0KByZFZIOiweD/Hj1ce5q52J5pRTR9smJ1geAu" +
  "SPtRL/Vvl7E5uJ498a1S2CEoQnSbvkiN/nMdXE9/+CB3aNQaKgplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0Zv" +
  "bnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago2IDAgb2JqCjw8IC9GaWx0ZXIgL1N0YW5k" +
  "YXJkIC9WIDUgL1IgNiAvTGVuZ3RoIDI1NiAvQ0YgPDwgL1N0ZENGIDw8IC9DRk0gL0FFU1YzIC9BdXRoRXZlbnQgL0RvY09wZW4g" +
  "L0xlbmd0aCAzMiA+PiA+PiAvU3RtRiAvU3RkQ0YgL1N0ckYgL1N0ZENGIC9QIC00IC9PIDwxMzMyNTE3MDhmYWVjZGVjMGIyYTQ5" +
  "Njg4N2E2YzVlNDAzMjI0MTYwN2Y5ZWJkZGNmYjFhMzk1ODc3OTZiNWQ0ZjMxMjMxNTA2ZjhlYWRjY2ViMGEyOTQ4Njc4NmE1YzQ+" +
  "IC9VIDw5ZmEzZTc1Y2M2ZmJiNzgyODJjZjM0NmFiMDJlNGQ4OTI2NGNhMGQ3YzA5OTE3ZTZhMmYzNTNmYTQyZTExOTE5MGQyYzRi" +
  "NmE4OWE4YzdlNjExMzA0ZjZlOGRhY2NiZWE+IC9PRSA8MTczNjU1NzQ5M2IyZDFmMDBmMmU0ZDZjOGJhYWM5ZTgwNzI2NDU2NDgz" +
  "YTJjMWUwZmYxZTNkNWM3YjlhYjlkOD4gL1VFIDxiYTU5MGI5YTYwYjBiYmM5YWY2N2E1NmZiZjExNDA5MDBkNWViNWMzYjgxNjE4" +
  "YjRlZTAzMDU3NjdmNTE2NDA0PiAvUGVybXMgPDFkM2M1YjdhOTliOGQ3ZjYxNTM0NTM3MjkxYjBjZmVlPiA+PgplbmRvYmoKeHJl" +
  "ZgowIDcKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDEx" +
  "NSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzNTUgMDAwMDAgbiAKMDAwMDAwMDQyNSAwMDAwMCBuIAp0cmFp" +
  "bGVyCjw8IC9TaXplIDcgL1Jvb3QgMSAwIFIgL0VuY3J5cHQgNiAwIFIgL0lEIFs8MDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2Nk" +
  "ZGVlZmY+IDwwMDExMjIzMzQ0NTU2Njc3ODg5OWFhYmJjY2RkZWVmZj5dID4+CnN0YXJ0eHJlZgo5NzIKJSVFT0YK"
  , "base64");

const R5_PASSWORD = Buffer.from(
  "JVBERi0xLjcKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUg" +
  "L1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAg" +
  "UiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIg" +
  "Pj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA2NCA+PgpzdHJlYW0KByZFZIOiweD/Hj1ce5q52J5pRTR9smJ1geAu" +
  "SPtRL/Vvl7E5uJ498a1S2CEoQnSbvkiN/nMdXE9/+CB3aNQaKgplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0Zv" +
  "bnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago2IDAgb2JqCjw8IC9GaWx0ZXIgL1N0YW5k" +
  "YXJkIC9WIDUgL1IgNSAvTGVuZ3RoIDI1NiAvQ0YgPDwgL1N0ZENGIDw8IC9DRk0gL0FFU1YzIC9BdXRoRXZlbnQgL0RvY09wZW4g" +
  "L0xlbmd0aCAzMiA+PiA+PiAvU3RtRiAvU3RkQ0YgL1N0ckYgL1N0ZENGIC9QIC00IC9PIDwxMzMyNTE3MDhmYWVjZGVjMGIyYTQ5" +
  "Njg4N2E2YzVlNDAzMjI0MTYwN2Y5ZWJkZGNmYjFhMzk1ODc3OTZiNWQ0ZjMxMjMxNTA2ZjhlYWRjY2ViMGEyOTQ4Njc4NmE1YzQ+" +
  "IC9VIDxkN2QzY2I0MWEwZWM3Y2VlMTU1MGU3MDQ0N2RiYjQ0NTQ3YWVmYTYyOTk5YWZkMGMyMDM3YTgyM2ZjYjVhMjM5MGQyYzRi" +
  "NmE4OWE4YzdlNjExMzA0ZjZlOGRhY2NiZWE+IC9PRSA8MTczNjU1NzQ5M2IyZDFmMDBmMmU0ZDZjOGJhYWM5ZTgwNzI2NDU2NDgz" +
  "YTJjMWUwZmYxZTNkNWM3YjlhYjlkOD4gL1VFIDw0MDI0OGNkZmQxZTU5ZWRkYThjMGQ1Y2E3ZGI0MzA0MDI5NDA0YWY2MmU3NDI0" +
  "MzJkOTQ5YzkzMTFjNDY4OTQ2PiAvUGVybXMgPDFkM2M1YjdhOTliOGQ3ZjYxNTM0NTM3MjkxYjBjZmVlPiA+PgplbmRvYmoKeHJl" +
  "ZgowIDcKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDEx" +
  "NSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzNTUgMDAwMDAgbiAKMDAwMDAwMDQyNSAwMDAwMCBuIAp0cmFp" +
  "bGVyCjw8IC9TaXplIDcgL1Jvb3QgMSAwIFIgL0VuY3J5cHQgNiAwIFIgL0lEIFs8MDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2Nk" +
  "ZGVlZmY+IDwwMDExMjIzMzQ0NTU2Njc3ODg5OWFhYmJjY2RkZWVmZj5dID4+CnN0YXJ0eHJlZgo5NzIKJSVFT0YK"
  , "base64");

const CONTENT = "BT /F1 24 Tf 72 700 Td (Secret AES text) Tj ET";

function contentOf(file: Buffer, password?: string): string | null | undefined {
  const text = file.toString("latin1");
  const stream = indexObjects(text).objects.get(4)!.stream!;
  return streamDecryptor(text, password)?.(4, 0, text.slice(stream.start, stream.end));
}

test("revision 6, empty user password: the content stream decrypts to what poppler reads", () => {
  assert.equal(contentOf(R6_EMPTY_PASSWORD), CONTENT);
});

test("revision 6, a user password with a non-ASCII letter: decrypts with it, is refused without and with another", () => {
  assert.equal(contentOf(R6_PASSWORD, "p\u00e4ssword"), CONTENT);
  assert.equal(contentOf(R6_PASSWORD), undefined);
  assert.equal(contentOf(R6_PASSWORD, "wrong"), undefined);
});

test("revision 5, a user password with a non-ASCII letter: decrypts with it and is refused without", () => {
  assert.equal(contentOf(R5_PASSWORD, "p\u00e4ssword"), CONTENT);
  assert.equal(contentOf(R5_PASSWORD), undefined);
});
