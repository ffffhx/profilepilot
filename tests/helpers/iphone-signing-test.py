"""Offline signing tests. All keys, certificates and device profiles are synthetic."""
import asyncio
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch
from datetime import datetime, timedelta, timezone
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID

spec = importlib.util.spec_from_file_location("iphone_signing", Path(__file__).resolve().parents[2] / "public/iphone/sideloadly_identity.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
UDID = "00008110-0011223344556677"


class SigningTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pp-iphone-signing-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        identity = self.root / "Sideloadly"
        identity.mkdir()
        self.output = self.root / "output"
        self.output.mkdir()
        self.key = rsa.generate_private_key(65537, 2048)
        subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Offline test identity")])
        now = datetime.now(timezone.utc)
        self.cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(self.key.public_key())
                     .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(days=1))
                     .not_valid_after(now + timedelta(days=7)).sign(self.key, hashes.SHA256()))
        (identity / "key.pem").write_bytes(self.key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        (identity / "cert-test.pem").write_bytes(self.cert.public_bytes(serialization.Encoding.PEM))
        self.profile = {"TeamIdentifier": ["TESTTEAM"], "ProvisionedDevices": [UDID], "ExpirationDate": now + timedelta(days=7),
                        "DeveloperCertificates": [self.cert.public_bytes(serialization.Encoding.DER)],
                        "Entitlements": {"application-identifier": "TESTTEAM.dev.test.WebDriverAgentRunner", "com.apple.developer.team-identifier": "TESTTEAM", "get-task-allow": True}}
        self.profiles = [SimpleNamespace(plist=self.profile, buf=b"synthetic-profile")]
        self.closed = False
        owner = self

        class Connection:
            async def close(self):
                owner.closed = True

        async def create_using_usbmux(*, serial, connection_type, usbmux_address):
            owner.assertEqual(serial, UDID)
            owner.assertEqual(connection_type, "USB")
            owner.assertEqual(usbmux_address, "127.0.0.1:27015")
            return Connection()

        class Misagent:
            def __init__(self, *, lockdown):
                pass
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                pass
            async def copy_all(self):
                return owner.profiles

        lockdown = ModuleType("pymobiledevice3.lockdown")
        lockdown.create_using_usbmux = create_using_usbmux
        misagent = ModuleType("pymobiledevice3.services.misagent")
        misagent.MisagentService = Misagent
        self.patches = [patch.dict(os.environ, {"APPDATA": str(self.root)}), patch.object(sys, "platform", "win32"),
                        patch.dict(sys.modules, {"pymobiledevice3.lockdown": lockdown, "pymobiledevice3.services.misagent": misagent})]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def prepare(self, bundle=""):
        return asyncio.run(helper.prepare(UDID, str(self.output), bundle))

    def test_valid_profile_exports_only_matching_identity(self):
        result = self.prepare()
        self.assertEqual(result["bundleId"], "dev.test.WebDriverAgentRunner")
        key, cert, _ = pkcs12.load_key_and_certificates((self.output / "identity.p12").read_bytes(), None)
        self.assertEqual(key.private_numbers(), self.key.private_numbers())
        self.assertEqual(cert, self.cert)
        self.assertTrue(self.closed)

    def test_other_device_is_rejected(self):
        self.profile["ProvisionedDevices"] = ["different-device"]
        with self.assertRaisesRegex(ValueError, "profile_missing"):
            self.prepare()
        self.assertEqual(list(self.output.iterdir()), [])

    def test_expired_profile_is_rejected(self):
        self.profile["ExpirationDate"] = datetime.now(timezone.utc) - timedelta(seconds=1)
        with self.assertRaisesRegex(ValueError, "profile_missing"):
            self.prepare()

    def test_other_certificate_is_rejected(self):
        self.profile["DeveloperCertificates"] = [b"different-certificate"]
        with self.assertRaisesRegex(ValueError, "profile_missing"):
            self.prepare()

    def test_multiple_bundles_require_explicit_selection(self):
        second = {**self.profile, "Entitlements": {**self.profile["Entitlements"], "application-identifier": "TESTTEAM.dev.other.WebDriverAgentRunner"}}
        self.profiles.append(SimpleNamespace(plist=second, buf=b"other-profile"))
        with self.assertRaisesRegex(ValueError, "bundle_ambiguous"):
            self.prepare()
        self.assertEqual(self.prepare("dev.other.WebDriverAgentRunner")["bundleId"], "dev.other.WebDriverAgentRunner")


if __name__ == "__main__":
    unittest.main()
