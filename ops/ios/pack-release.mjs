import { writeFile } from "node:fs/promises";
import { MAX_IOS_IPA_BYTES, MAX_IOS_METADATA_BYTES } from "../../src/lib/ios-release-manifest.mjs";
import { boundedFile, encodeIosPayload } from "./release.mjs";

const [metadata, ipa, output] = process.argv.slice(2);
const release = JSON.parse(await boundedFile(metadata, MAX_IOS_METADATA_BYTES));
await writeFile(output, encodeIosPayload(release, await boundedFile(ipa, MAX_IOS_IPA_BYTES)), { mode: 0o600, flag: "wx" });
