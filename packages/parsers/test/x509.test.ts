import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { X509Parser } from "../src/index.ts";

const pem = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIURB6AawdBoSceQKEuUVBDE4Py6VgwDQYJKoZIhvcNAQELBQAwIzESMBAGA1UE
AwwJVGVzdCBDZXJ0MQ0wCwYDVQQKDARBQ01FMB4XDTI2MTEwNTAxMDgzMloXDTI2MTEwNjAxMDgzMlow
IzESMBAGA1UEAwwJVGVzdCBDZXJ0MQ0wCwYDVQQKDARBQ01FMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A
MIIBCgKCAQEAlgTGi12CFCH2HBhkvC0EGFjL267wmYUT1G2HnX8VUJvdl6qwVh3/XfAYS3lIdZayspjD
oRmOHIRhvhyICyyg8ZV5IHG8nWEkElXyRK6HN/ZPmxs/glSFxvwjNvhVmIjRiVe3HGTeUz3VMzy+wF5G
IgnA3Bh6F+syM+y9fS+fwbJ3I4hjDhMwtO8hGhFnWtRm81jaqSQNw+1Krt2MnNtbSGlUHIdqXXAITyLP
Rrndx/6N+bcANf0XjtupjvNAua0JRgkvZuvR9EOahY0cpb162GdZ0jfC9xuWX+2zd+TavfZs9EMbFSSL
6bhmQI+yGs/XSqEPYIjWEiQFd0804BryiwIDAQABo1MwUTAdBgNVHQ4EFgQUxVKrE5XSvA1qzFaZR6jk
wZ3049QwHwYDVR0jBBgwFoAUxVKrE5XSvA1qzFaZR6jkwZ3049QwDwYDVR0TAQH/BAUwAwEB/zANBgkq
hkiG9w0BAQsFAAOCAQEAgQDow0H9pKczDdVeq88B1Q4y4d8CZs7HLJLqV/K+3jcX6ZOQc/DYNUqfuph8
Oa0CodiOHEJQeiNZqdb4NSYKzOZ+q2mzK4NHuL6uvDSUlxBHSXZRbRxJzEOVvOyTZQnT1fUDxVWQfx/V
8Cxs7KKJ5yrqjovBLp2qe5iXCnZ8EmEA/PhDhaF6Nnkozr4XzIT74S/U1iJu1WLOs+Dwge3PC+4mx9kG
fhTJAFq40MQfqc0ug7y5m2uT5Hd/+7dLMifLUb9UNrUst+S9be2zVlilu5KgldFcc6sA+fk40moaoroo
UI4e7Ech5oDzLaTVY0k0ly+xl99c7kculjVWMMBhrg==
-----END CERTIFICATE-----`;

test("extracts X.509 subject, issuer, serial and validity", async () => {
  const stream = await RipstreamInputStream.from(new TextEncoder().encode(pem));
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  await new X509Parser().parse(stream, handler, metadata, new ParseContext());
  await stream.close();
  assert.match(metadata.get("x509:subject") ?? "", /CN=Test Cert/);
  assert.match(metadata.get("x509:issuer") ?? "", /O=ACME/);
  assert.match(metadata.get("x509:not-before") ?? "", /^2026-11-05/);
  assert.match(handler.toString(), /Serial/);
});

test("registers the detector's application/x-x509-cert type", async () => {
  const types = [...new X509Parser().getSupportedTypes()].map((type) => type.toString());
  assert.ok(types.includes("application/x-x509-cert"));
  const stream = await RipstreamInputStream.from(new TextEncoder().encode(pem));
  const metadata = new Metadata();
  await new X509Parser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  assert.match(metadata.get("x509:subject") ?? "", /CN=Test Cert/);
});

function tlv(tag: number, ...content: number[][]): number[] {
  const body = content.flat();
  return [tag, body.length, ...body];
}

function name(common: string): number[] {
  const text = [...new TextEncoder().encode(common)];
  return tlv(0x30, tlv(0x31, tlv(0x30, [0x06, 0x03, 0x55, 0x04, 0x03], tlv(0x0c, text))));
}

test("reads names whose DER length byte is 0x1f", async () => {
  const issuerName = name("A".repeat(20));
  assert.equal(issuerName[1], 0x1f);
  const time = (value: string): number[] => tlv(0x17, [...new TextEncoder().encode(value)]);
  const tbs = tlv(
    0x30,
    tlv(0x02, [0x01]),
    tlv(0x30),
    issuerName,
    tlv(0x30, time("260101000000Z"), time("270101000000Z")),
    name("subject"),
  );
  const der = new Uint8Array(tlv(0x30, tbs));
  const stream = await RipstreamInputStream.from(der);
  const metadata = new Metadata();
  await new X509Parser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  await stream.close();
  assert.equal(metadata.get("x509:issuer"), `CN=${"A".repeat(20)}`);
});
