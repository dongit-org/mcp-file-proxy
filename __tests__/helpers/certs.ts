import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestPki {
  dir: string;
  caCert: string;
  serverCert: string;
  serverKey: string;
  clientCert: string;
  clientKey: string;
  clientKeyEncrypted: string;
  clientKeyPassphrase: string;
}

function openssl(...args: string[]): void {
  execFileSync("openssl", args, { stdio: "pipe" });
}

/**
 * Generates a throwaway PKI for the TLS tests: a self-signed CA, a server
 * certificate valid for localhost/127.0.0.1, and a client certificate, all
 * signed by that CA, plus a passphrase-encrypted copy of the client key.
 * Requires the `openssl` CLI. If generation fails partway, the temporary
 * directory (and any private keys already written to it) is removed.
 *
 * @returns Paths to the generated PEM files.
 */
export function generateTestPki(): TestPki {
  const dir = mkdtempSync(join(tmpdir(), "mcp-proxy-tls-test-"));
  try {
    const at = (name: string): string => join(dir, name);
    const passphrase = "test-passphrase";

    openssl(
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
      "-keyout", at("ca.key"), "-out", at("ca.crt"), "-subj", "/CN=mcp-proxy test CA",
    );

    writeFileSync(at("server.ext"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n");
    openssl(
      "req", "-newkey", "rsa:2048", "-nodes",
      "-keyout", at("server.key"), "-out", at("server.csr"), "-subj", "/CN=localhost",
    );
    openssl(
      "x509", "-req", "-days", "2", "-in", at("server.csr"),
      "-CA", at("ca.crt"), "-CAkey", at("ca.key"), "-CAcreateserial",
      "-extfile", at("server.ext"), "-out", at("server.crt"),
    );

    openssl(
      "req", "-newkey", "rsa:2048", "-nodes",
      "-keyout", at("client.key"), "-out", at("client.csr"), "-subj", "/CN=test-client",
    );
    openssl(
      "x509", "-req", "-days", "2", "-in", at("client.csr"),
      "-CA", at("ca.crt"), "-CAkey", at("ca.key"), "-CAcreateserial",
      "-out", at("client.crt"),
    );

    openssl(
      "rsa", "-aes256", "-in", at("client.key"),
      "-passout", `pass:${passphrase}`, "-out", at("client.enc.key"),
    );

    return {
      dir,
      caCert: at("ca.crt"),
      serverCert: at("server.crt"),
      serverKey: at("server.key"),
      clientCert: at("client.crt"),
      clientKey: at("client.key"),
      clientKeyEncrypted: at("client.enc.key"),
      clientKeyPassphrase: passphrase,
    };
  } catch (error: unknown) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export function removeTestPki(pki: TestPki): void {
  rmSync(pki.dir, { recursive: true, force: true });
}
