"""Explicit Windows-only local signing step. Never reads Apple login/session data."""
import asyncio
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path


async def prepare(udid, output, requested_bundle=""):
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.serialization import pkcs12
    from pymobiledevice3.lockdown import create_using_usbmux
    from pymobiledevice3.services.misagent import MisagentService

    if sys.platform != "win32" or not re.fullmatch(r"(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{8}-[a-fA-F0-9]{16})", udid):
        raise ValueError("invalid_target")
    directory = Path(os.environ["APPDATA"]) / "Sideloadly"
    # Only the developer identity files, after an explicit signing request.
    key = serialization.load_pem_private_key((directory / "key.pem").read_bytes(), password=None)
    public = key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    certificates = []
    for file in sorted(directory.glob("cert-*.pem")):
        try:
            cert = x509.load_pem_x509_certificate(file.read_bytes())
            if cert.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo) == public:
                if cert.not_valid_before_utc <= datetime.now(timezone.utc) < cert.not_valid_after_utc:
                    certificates.append(cert)
        except ValueError:
            continue
    if not certificates:
        raise ValueError("identity_missing")
    lockdown = await create_using_usbmux(serial=udid, connection_type="USB", usbmux_address="127.0.0.1:27015")
    try:
        async with MisagentService(lockdown=lockdown) as service:
            profiles = await service.copy_all()
    finally:
        await lockdown.close()
    matches = []
    for profile in profiles:
        info = profile.plist
        ent = info.get("Entitlements", {})
        team = (info.get("TeamIdentifier") or [""])[0]
        appid = ent.get("application-identifier", "")
        bundle = appid[len(team) + 1:] if team and appid.startswith(team + ".") else ""
        expiry = info.get("ExpirationDate")
        if not isinstance(expiry, datetime):
            continue
        expiry = expiry.replace(tzinfo=timezone.utc) if expiry.tzinfo is None else expiry
        if not re.fullmatch(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+", bundle) or "webdriveragent" not in bundle.lower():
            continue
        if requested_bundle and requested_bundle != bundle:
            continue
        if udid not in info.get("ProvisionedDevices", []) or expiry <= datetime.now(timezone.utc) or ent.get("get-task-allow") is not True:
            continue
        if ent.get("com.apple.developer.team-identifier") != team:
            continue
        for cert in certificates:
            if cert.public_bytes(serialization.Encoding.DER) in info.get("DeveloperCertificates", []):
                matches.append((expiry, bundle, profile.buf, cert))
    if not matches:
        raise ValueError("profile_missing")
    if len({match[1] for match in matches}) != 1:
        raise ValueError("bundle_ambiguous")
    expiry, bundle, raw, cert = max(matches, key=lambda match: match[0])
    destination = Path(output)
    # The caller owns a private temporary directory and deletes these after signing.
    (destination / "identity.p12").write_bytes(pkcs12.serialize_key_and_certificates(b"ProfilePilot WDA", key, cert, None, serialization.NoEncryption()))
    (destination / "profile.mobileprovision").write_bytes(raw)
    return {"bundleId": bundle, "expiresAt": expiry.isoformat()}


if __name__ == "__main__":
    try:
        result = asyncio.run(prepare(*sys.argv[1:]))
        print(json.dumps(result))
    except Exception as error:
        # Pairing and signing libraries can include sensitive payloads in exceptions.
        code = str(error) if isinstance(error, ValueError) and str(error) in {"invalid_target", "identity_missing", "profile_missing", "bundle_ambiguous"} else "signing_prerequisite"
        print(json.dumps({"error": code}))
        sys.exit(1)
