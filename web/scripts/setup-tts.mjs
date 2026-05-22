#!/usr/bin/env node
/**
 * One-shot installer for the Piper TTS sidecar used by the Decision Maker
 * mock interview. Run with: `npm run setup:tts` (from web/).
 *
 * Downloads:
 *   - piper binary for the current OS (Windows / macOS / Linux)
 *   - en_US-amy-medium voice model (~60MB) + its config
 *
 * All files land in web/server/tts/ (gitignored). Safe to re-run — existing
 * files are skipped.
 */
import fs from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TTS_DIR = path.resolve(__dirname, "..", "server", "tts");

const PIPER_VERSION = "2023.11.14-2"; // latest stable release tag at time of writing
const PIPER_RELEASES = `https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}`;

const VOICE = "en_US-amy-medium";
const VOICE_BASE_URL = `https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium`;

function platformAsset() {
  const p = process.platform;
  const a = process.arch;
  if (p === "win32" && a === "x64") return { zip: "piper_windows_amd64.zip", binary: "piper.exe" };
  if (p === "darwin" && a === "arm64") return { zip: "piper_macos_aarch64.tar.gz", binary: "piper" };
  if (p === "darwin" && a === "x64") return { zip: "piper_macos_x64.tar.gz", binary: "piper" };
  if (p === "linux" && a === "x64") return { zip: "piper_linux_x86_64.tar.gz", binary: "piper" };
  if (p === "linux" && a === "arm64") return { zip: "piper_linux_aarch64.tar.gz", binary: "piper" };
  throw new Error(`unsupported platform: ${p} ${a}`);
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function download(url, dest) {
  console.log(`  ↓ ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`download failed (${res.status}) ${url}`);
  }
  await pipeline(res.body, createWriteStream(dest));
}

async function extractZipWindows(zipPath, destDir) {
  // PowerShell's Expand-Archive ships with Windows 10+
  return new Promise((resolve, reject) => {
    const p = spawn(
      "powershell.exe",
      ["-NoProfile", "-Command", `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`],
      { stdio: "inherit" },
    );
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Expand-Archive exit ${code}`))));
  });
}

async function extractTarballPosix(tarPath, destDir) {
  return new Promise((resolve, reject) => {
    const p = spawn("tar", ["-xzf", tarPath, "-C", destDir], { stdio: "inherit" });
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar exit ${code}`))));
  });
}

async function flattenPiperDir(destDir) {
  // The release archives extract into a `piper/` subfolder. Move its contents up.
  const inner = path.join(destDir, "piper");
  if (!existsSync(inner)) return;
  const items = await fs.readdir(inner);
  for (const name of items) {
    const from = path.join(inner, name);
    const to = path.join(destDir, name);
    await fs.rename(from, to).catch(async (err) => {
      // If a directory like espeak-ng-data already exists from a prior run, replace it.
      if (err && err.code === "ENOTEMPTY") {
        await fs.rm(to, { recursive: true, force: true });
        await fs.rename(from, to);
      } else if (err) {
        throw err;
      }
    });
  }
  await fs.rm(inner, { recursive: true, force: true });
}

async function main() {
  console.log(`Setting up Piper TTS in ${TTS_DIR}`);
  await ensureDir(TTS_DIR);

  const asset = platformAsset();
  const binaryPath = path.join(TTS_DIR, asset.binary);

  if (existsSync(binaryPath)) {
    console.log(`✓ piper binary already present: ${asset.binary}`);
  } else {
    const tmpArchive = path.join(os.tmpdir(), asset.zip);
    console.log(`Downloading piper ${PIPER_VERSION} (${asset.zip})…`);
    await download(`${PIPER_RELEASES}/${asset.zip}`, tmpArchive);
    console.log("Extracting…");
    if (asset.zip.endsWith(".zip")) {
      await extractZipWindows(tmpArchive, TTS_DIR);
    } else {
      await extractTarballPosix(tmpArchive, TTS_DIR);
    }
    await flattenPiperDir(TTS_DIR);
    await fs.unlink(tmpArchive).catch(() => {});
    if (!existsSync(binaryPath)) {
      throw new Error(`extraction completed but ${asset.binary} not found in ${TTS_DIR}`);
    }
    if (process.platform !== "win32") {
      await fs.chmod(binaryPath, 0o755).catch(() => {});
    }
    console.log(`✓ installed ${asset.binary}`);
  }

  const onnx = path.join(TTS_DIR, `${VOICE}.onnx`);
  const onnxJson = path.join(TTS_DIR, `${VOICE}.onnx.json`);

  if (existsSync(onnx) && existsSync(onnxJson)) {
    console.log(`✓ voice ${VOICE} already present`);
  } else {
    console.log(`Downloading voice ${VOICE}…`);
    await download(`${VOICE_BASE_URL}/${VOICE}.onnx`, onnx);
    await download(`${VOICE_BASE_URL}/${VOICE}.onnx.json`, onnxJson);
    console.log(`✓ installed voice ${VOICE}`);
  }

  console.log("");
  console.log("Done. The dev API should pick this up on next request. Restart it if needed.");
}

main().catch((err) => {
  console.error("setup-tts failed:", err.message || err);
  process.exit(1);
});
