import base64
import hashlib
import json
import os
from datetime import UTC, datetime
from pathlib import Path
import plistlib
import re
import subprocess
import sys
from urllib.parse import urlparse


def require(value):
    if not value:
        raise ValueError("Invalid Ad Hoc signing data")


def read_plist(path):
    return plistlib.loads(path.read_bytes())


def write_plist(path, value):
    path.write_bytes(plistlib.dumps(value))


phase, work = sys.argv[1], Path(sys.argv[2])
team = os.environ["IOS_TEAM_ID"]
bundle = os.environ["IOS_BUNDLE_ID"]
origin = os.environ["IOS_PUBLIC_ORIGIN"]
version = os.environ["BILLBOARD_IOS_VERSION"]
build = os.environ["BILLBOARD_IOS_BUILD"]
require(re.fullmatch(r"[A-Z0-9]{10}", team))
require(len(bundle) <= 155 and re.fullmatch(r"[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+", bundle))
require(re.fullmatch(r"\d{1,4}\.\d{1,4}\.\d{1,4}", version))
require(re.fullmatch(r"[1-9]\d{0,3}\.\d{1,2}\.\d{1,2}", build))
require(re.fullmatch(r"https://[a-z0-9.-]+(:[0-9]{1,5})?/?", origin))
url = urlparse(origin)
require(url.hostname and (url.port is None or 1 <= url.port <= 65535))


def verify_profile(profile):
    entitlements = profile["Entitlements"]
    require(profile["TeamIdentifier"] == [team] and "iOS" in profile["Platform"])
    require(entitlements["application-identifier"] == f"{team}.{bundle}")
    require(not entitlements.get("get-task-allow") and not profile.get("ProvisionsAllDevices"))
    require(isinstance(profile.get("ProvisionedDevices"), list) and len(profile["ProvisionedDevices"]) > 0)
    require(profile["ExpirationDate"].replace(tzinfo=UTC) > datetime.now(UTC))
    require(re.fullmatch(r"[0-9a-fA-F-]{36}", profile["UUID"]))


if phase == "prepare":
    require(os.environ["IOS_P12_PASSWORD"])
    for name, filename in (("IOS_P12_BASE64", "distribution.p12"), ("IOS_PROFILE_BASE64", "build.mobileprovision")):
        value = base64.b64decode(os.environ[name], validate=True)
        require(0 < len(value) <= 48 * 1024)
        (work / filename).write_bytes(value)
    info = read_plist(Path("ios/BillBoard/Info.plist"))
    info["BillBoardOrigin"] = origin
    write_plist(work / "Info.plist", info)
elif phase == "profile":
    profile = read_plist(work / "profile.plist")
    verify_profile(profile)
    print(profile["UUID"])
elif phase == "export":
    profile = read_plist(work / "profile.plist")
    verify_profile(profile)
    certificate = os.environ["IOS_CERTIFICATE_ID"]
    require(certificate in [hashlib.sha1(der).hexdigest().upper() for der in profile["DeveloperCertificates"]])
    write_plist(work / "ExportOptions.plist", {
        "method": "release-testing", "destination": "export", "signingStyle": "manual",
        "teamID": team, "signingCertificate": certificate, "provisioningProfiles": {bundle: profile["UUID"]},
        "manageAppVersionAndBuildNumber": False,
    })
elif phase == "verify":
    info = read_plist(work / "extracted/Payload/BillBoard.app/Info.plist")
    require(info["CFBundleIdentifier"] == bundle and info["BillBoardOrigin"] == origin)
    require(info["CFBundleShortVersionString"] == version and info["CFBundleVersion"] == build)
    embedded = read_plist(work / "embedded.plist")
    verify_profile(embedded)
    require(embedded["UUID"] == read_plist(work / "profile.plist")["UUID"])
    signed = read_plist(work / "entitlements.plist")
    require(signed["application-identifier"] == f"{team}.{bundle}" and signed["com.apple.developer.team-identifier"] == team)
    require(not signed.get("get-task-allow"))
    cert = work / "actual-certificate-0"
    require(cert.read_bytes() in embedded["DeveloperCertificates"])
    require(hashlib.sha1(cert.read_bytes()).hexdigest().upper() == os.environ["IOS_CERTIFICATE_ID"])
    not_after = subprocess.check_output(["openssl", "x509", "-inform", "DER", "-in", str(cert), "-noout", "-enddate"], text=True)
    cert_end = datetime.strptime(not_after.strip().removeprefix("notAfter="), "%b %d %H:%M:%S %Y %Z").replace(tzinfo=UTC)
    expiry = min(cert_end, embedded["ExpirationDate"].replace(tzinfo=UTC))
    require(expiry > datetime.now(UTC))
    ipa = work / "export/BillBoard.ipa"
    size = ipa.stat().st_size
    require(0 < size <= 64 * 1024 * 1024)
    with ipa.open("rb") as file:
        digest = hashlib.file_digest(file, "sha256").hexdigest()
    (work / "metadata.json").write_text(json.dumps({
        "schema": 1, "version": version, "build": build, "bundleId": bundle, "teamId": team,
        "sourceCommit": os.environ["GITHUB_SHA"], "runId": int(os.environ["GITHUB_RUN_ID"]),
        "runNumber": int(os.environ["GITHUB_RUN_NUMBER"]), "attempt": int(os.environ["GITHUB_RUN_ATTEMPT"]),
        "sha256": digest, "size": size, "validUntil": int(expiry.timestamp() * 1000),
    }), encoding="utf-8")
else:
    raise ValueError("Unknown signing stage")
