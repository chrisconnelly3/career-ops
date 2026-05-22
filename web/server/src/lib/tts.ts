import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Response } from "express";

/**
 * Piper TTS sidecar.
 *
 * Expects:
 *   web/server/tts/piper.exe        (Windows binary, or "piper" on macOS/Linux)
 *   web/server/tts/<voice>.onnx     (any voice model; first .onnx file wins)
 *   web/server/tts/<voice>.onnx.json
 *
 * Run `npm run setup:tts` (from web/) to fetch the Windows binary + the
 * en_US-amy-medium voice. The binary and model files are gitignored.
 */
// tts.ts lives at web/server/src/lib/tts.ts; the binary + voice files are at
// web/server/tts/ (created by web/scripts/setup-tts.mjs).
const TTS_DIR = path.resolve(__dirname, "..", "..", "tts");
const BINARY_NAME = process.platform === "win32" ? "piper.exe" : "piper";

export type TtsStatus =
  | { available: true; voice: string; binaryPath: string; modelPath: string; configPath: string }
  | { available: false; reason: string };

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function getTtsStatus(): Promise<TtsStatus> {
  const binaryPath = path.join(TTS_DIR, BINARY_NAME);
  if (!(await fileExists(binaryPath))) {
    return {
      available: false,
      reason: `piper binary not found — run \`npm run setup:tts\` from web/ to install`,
    };
  }
  let entries: string[];
  try {
    entries = await fs.readdir(TTS_DIR);
  } catch {
    return { available: false, reason: "tts/ directory missing" };
  }
  const modelFile = entries.find((f) => f.endsWith(".onnx") && !f.endsWith(".json"));
  if (!modelFile) {
    return { available: false, reason: "no .onnx voice model in tts/" };
  }
  const configFile = `${modelFile}.json`;
  const modelPath = path.join(TTS_DIR, modelFile);
  const configPath = path.join(TTS_DIR, configFile);
  if (!(await fileExists(configPath))) {
    return { available: false, reason: `voice config ${configFile} missing` };
  }
  const voice = modelFile.replace(/\.onnx$/, "");
  return { available: true, voice, binaryPath, modelPath, configPath };
}

/**
 * Synthesize `text` using Piper and stream the resulting WAV back to the client.
 * Implementation note: piper writes WAV when given a real file path; stdout
 * behavior differs by build, so we round-trip through a temp file to keep this
 * predictable across versions.
 */
export async function speakWithPiper(text: string, res: Response): Promise<void> {
  const status = await getTtsStatus();
  if (!status.available) {
    res.status(503).json({ ok: false, error: status.reason });
    return;
  }

  const trimmed = text.trim();
  if (!trimmed) {
    res.status(400).json({ ok: false, error: "empty text" });
    return;
  }

  const tmpDir = os.tmpdir();
  const outFile = path.join(tmpDir, `piper-${randomUUID()}.wav`);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      status.binaryPath,
      ["--model", status.modelPath, "--config", status.configPath, "--output_file", outFile],
      { cwd: TTS_DIR },
    );

    let stderrBuf = "";
    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`piper exited with code ${code}: ${stderrBuf.slice(0, 400)}`));
    });

    proc.stdin.write(trimmed);
    proc.stdin.end();
  });

  try {
    const audio = await fs.readFile(outFile);
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Length", String(audio.length));
    res.setHeader("Cache-Control", "no-store");
    res.end(audio);
  } finally {
    fs.unlink(outFile).catch(() => {});
  }
}
