import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const identityName = "ProfilePilot Input Guard Local Signing";
const signingDir = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "ProfilePilot",
  "CodeSigning"
);
const keychainPath = path.join(signingDir, "input-guard-signing.keychain-db");
const passwordPath = path.join(signingDir, "keychain-password");

if (process.platform !== "darwin") {
  console.log("Input Guard 本地签名仅在 macOS 上需要。");
  process.exit(0);
}

await mkdir(signingDir, { recursive: true, mode: 0o700 });
await chmod(signingDir, 0o700);

let password = await readPrivateText(passwordPath);
if (!password) {
  password = randomBytes(32).toString("base64url");
  await writeFile(passwordPath, `${password}\n`, { encoding: "utf8", mode: 0o600 });
}
await chmod(passwordPath, 0o600);

if (!(await hasTrustedIdentity(keychainPath, password))) {
  let existingCertificate = await exportCertificate(keychainPath, password);
  if (!existingCertificate) {
    await createSigningIdentity({ keychainPath, password });
    existingCertificate = await exportCertificate(keychainPath, password);
  }
  if (!existingCertificate) {
    throw new Error("本地签名证书创建失败");
  }
  await trustCertificate({
    certificatePath: existingCertificate.path,
    keychainPath,
    cleanup: existingCertificate.cleanup
  });
}

await execFileAsync("security", ["unlock-keychain", "-p", password, keychainPath]);
const identity = await findTrustedIdentity(keychainPath);
if (!identity) {
  throw new Error("本地签名证书创建完成，但 codesign 无法找到私钥");
}

await removeKeychainFromSearchList(keychainPath);
console.log(`Input Guard 稳定本地签名已就绪：${identity.fingerprint}`);

async function createSigningIdentity(input) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "profilepilot-input-guard-signing-"));
  const certificatePath = path.join(tempDir, "certificate.pem");
  const privateKeyPath = path.join(tempDir, "private-key.pem");
  const pkcs12Path = path.join(tempDir, "identity.p12");
  const configPath = path.join(tempDir, "openssl.cnf");
  const pkcs12Password = randomBytes(32).toString("base64url");

  try {
    await rm(input.keychainPath, { force: true });
    await execFileAsync("security", ["create-keychain", "-p", input.password, input.keychainPath]);
    await execFileAsync("security", [
      "set-keychain-settings",
      "-lut",
      "21600",
      input.keychainPath
    ]);
    await execFileAsync("security", ["unlock-keychain", "-p", input.password, input.keychainPath]);

    await writeFile(
      configPath,
      `[req]\n` +
        `distinguished_name = subject\n` +
        `x509_extensions = code_signing\n` +
        `prompt = no\n` +
        `[subject]\n` +
        `CN = ${identityName}\n` +
        `[code_signing]\n` +
        `basicConstraints = critical,CA:TRUE\n` +
        `keyUsage = critical,digitalSignature,keyCertSign\n` +
        `extendedKeyUsage = critical,codeSigning\n` +
        `subjectKeyIdentifier = hash\n` +
        `authorityKeyIdentifier = keyid:always\n`,
      "utf8"
    );
    await execFileAsync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-days",
      "3650",
      "-keyout",
      privateKeyPath,
      "-out",
      certificatePath,
      "-config",
      configPath,
      "-extensions",
      "code_signing"
    ]);
    await execFileAsync("openssl", [
      "pkcs12",
      "-export",
      "-inkey",
      privateKeyPath,
      "-in",
      certificatePath,
      "-name",
      identityName,
      "-passout",
      `pass:${pkcs12Password}`,
      "-out",
      pkcs12Path
    ]);
    await execFileAsync("security", [
      "import",
      pkcs12Path,
      "-k",
      input.keychainPath,
      "-P",
      pkcs12Password,
      "-T",
      "/usr/bin/codesign",
      "-T",
      "/usr/bin/security"
    ]);
    await execFileAsync("security", [
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:,codesign:",
      "-s",
      "-k",
      input.password,
      input.keychainPath
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function exportCertificate(keychain, keychainPassword) {
  try {
    await execFileAsync("security", ["unlock-keychain", "-p", keychainPassword, keychain]);
    const { stdout } = await execFileAsync("security", [
      "find-certificate",
      "-p",
      "-c",
      identityName,
      keychain
    ]);
    if (!stdout.includes("BEGIN CERTIFICATE")) {
      return null;
    }
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "profilepilot-input-guard-cert-"));
    const certificatePath = path.join(tempDir, "certificate.pem");
    await writeFile(certificatePath, stdout, "utf8");
    return {
      path: certificatePath,
      cleanup: () => rm(tempDir, { recursive: true, force: true })
    };
  } catch {
    return null;
  }
}

async function trustCertificate(input) {
  try {
    // Trust is deliberately restricted to the code-signing policy. It is not
    // installed as a general TLS trust anchor.
    await execFileAsync("security", [
      "add-trusted-cert",
      "-r",
      "trustRoot",
      "-p",
      "codeSign",
      "-k",
      input.keychainPath,
      input.certificatePath
    ]);
  } finally {
    await input.cleanup?.();
  }
}

async function hasTrustedIdentity(keychain, keychainPassword) {
  try {
    await execFileAsync("security", ["unlock-keychain", "-p", keychainPassword, keychain]);
    return Boolean(await findTrustedIdentity(keychain));
  } catch {
    return false;
  }
}

async function findTrustedIdentity(keychain) {
  try {
    const { stdout } = await execFileAsync("security", [
      "find-identity",
      "-v",
      "-p",
      "codesigning",
      keychain
    ]);
    const escapedName = identityName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = stdout.match(new RegExp(`([0-9A-F]{40}) \\"${escapedName}\\"`));
    return match ? { fingerprint: match[1] } : null;
  } catch {
    return null;
  }
}

async function removeKeychainFromSearchList(keychain) {
  const { stdout } = await execFileAsync("security", ["list-keychains", "-d", "user"]);
  const keychains = [...stdout.matchAll(/\"([^\"]+)\"/g)].map((match) => match[1]);
  if (keychains.includes(keychain)) {
    await execFileAsync("security", [
      "list-keychains",
      "-d",
      "user",
      "-s",
      ...keychains.filter((candidate) => candidate !== keychain)
    ]);
  }
}

async function readPrivateText(filePath) {
  try {
    return (await readFile(filePath, "utf8")).trim();
  } catch {
    return "";
  }
}
