import argparse
import gc
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import wave


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as stream:
        return stream.getnframes() / stream.getframerate()


def normalized_narration(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg.exe", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(source),
            "-af", "atempo=1.06,loudnorm=I=-18:TP=-2:LRA=7",
            "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le",
            str(target),
        ],
        check=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--project-dir", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--prompt", type=Path, required=True)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--max-new", type=int, default=0)
    args = parser.parse_args()

    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        os.environ.pop(name, None)
    os.environ["NO_PROXY"] = "*"
    os.environ["no_proxy"] = "*"
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"

    project_dir = args.project_dir.resolve()
    model_dir = args.model_dir.resolve()
    prompt = args.prompt.resolve()
    manifest_path = args.manifest.resolve()
    if not manifest_path.is_file():
        raise FileNotFoundError(manifest_path)
    if not prompt.is_file():
        raise FileNotFoundError(prompt)
    sys.path.insert(0, str(project_dir))

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    queue = []
    for segment in manifest.get("segments", []):
        for cue_index, cue in enumerate(segment.get("narrationCues", []), 1):
            text = str(cue.get("text") or "").strip()
            if text:
                queue.append((segment, cue_index, cue, text))
    if args.limit:
        queue = queue[: args.limit]
    if not queue:
        raise RuntimeError("Manifest has no narration cues")

    print(json.dumps({"stage": "load", "cues": len(queue), "bf16": True, "lowVram": True}), flush=True)
    from indextts.infer_v2_5 import IndexTTS2
    import torch

    started = time.perf_counter()
    tts = IndexTTS2(
        cfg_path=str(model_dir / "config.yaml"),
        model_dir=str(model_dir),
        device="cuda:0",
        use_bf16=True,
        use_cuda_kernel=False,
        use_deepspeed=False,
        use_accel=False,
        use_torch_compile=False,
        use_qwen_emo=False,
    )
    print(json.dumps({
        "stage": "loaded",
        "seconds": round(time.perf_counter() - started, 3),
        "allocatedMiB": round(torch.cuda.memory_allocated() / 1024 / 1024, 1),
        "reservedMiB": round(torch.cuda.memory_reserved() / 1024 / 1024, 1),
    }), flush=True)

    narration_dir = manifest_path.parent / "narration"
    narration_dir.mkdir(parents=True, exist_ok=True)
    generated_count = 0
    for completed, (segment, cue_index, cue, text) in enumerate(queue, 1):
        fingerprint = hashlib.sha256(text.encode("utf-8")).hexdigest()[:10]
        filename = f"{segment['id']}-{cue_index:02d}-{fingerprint}.wav"
        target = narration_dir / filename
        relative_target = target.relative_to(manifest_path.parent).as_posix()
        if target.is_file() and not args.force:
            cue["file"] = relative_target
            cue["duration"] = wav_duration(target)
            cue["engine"] = "IndexTTS 2.5 BF16"
            cue["reused"] = True
        else:
            raw = narration_dir / f".{filename}.raw.wav"
            cue_started = time.perf_counter()
            tts.infer(
                spk_audio_prompt=str(prompt),
                text=text,
                lang="ZH",
                output_path=str(raw),
                emo_vector=[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.62],
                emo_alpha=0.82,
                use_random=False,
                duration_factor=0.90,
                interval_silence=120,
                verbose=False,
                text_normalization=True,
                temperature=0.72,
                top_p=0.82,
                top_k=30,
            )
            normalized_narration(raw, target)
            raw.unlink(missing_ok=True)
            cue["file"] = relative_target
            cue["duration"] = wav_duration(target)
            cue["engine"] = "IndexTTS 2.5 BF16"
            cue["generationSeconds"] = round(time.perf_counter() - cue_started, 3)
            cue["reused"] = False
            generated_count += 1
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({
            "stage": "cue",
            "completed": completed,
            "total": len(queue),
            "segment": segment["id"],
            "title": cue.get("title"),
            "duration": round(cue["duration"], 3),
            "file": cue["file"],
            "reused": cue["reused"],
        }, ensure_ascii=False), flush=True)

        if not cue["reused"]:
            gc.collect()
            torch.cuda.empty_cache()
        if args.max_new and generated_count >= args.max_new:
            break

    remaining = []
    for segment in manifest.get("segments", []):
        for cue in segment.get("narrationCues", []):
            cue_file = cue.get("file")
            if cue.get("text") and (not cue_file or not (manifest_path.parent / cue_file).is_file()):
                remaining.append({"segment": segment.get("id"), "title": cue.get("title")})
    if remaining:
        print(json.dumps({
            "stage": "partial",
            "generated": generated_count,
            "remaining": len(remaining),
        }, ensure_ascii=False), flush=True)
        return

    overlaps = []
    for segment in manifest.get("segments", []):
        cues = segment.get("narrationCues", [])
        for index, cue in enumerate(cues[:-1]):
            end = float(cue.get("start", 0)) + float(cue.get("duration", 0))
            next_start = float(cues[index + 1].get("start", 0))
            if end > next_start:
                overlaps.append({
                    "segment": segment["id"],
                    "cue": index + 1,
                    "overlapSeconds": round(end - next_start, 3),
                })
    manifest["narration"] = {
        "engine": "IndexTTS 2.5",
        "precision": "BF16",
        "prompt": prompt.name,
        "normalizedLufs": -18,
        "overlaps": overlaps,
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "stage": "complete",
        "cues": len(queue),
        "overlaps": overlaps,
        "peakAllocatedMiB": round(torch.cuda.max_memory_allocated() / 1024 / 1024, 1),
        "peakReservedMiB": round(torch.cuda.max_memory_reserved() / 1024 / 1024, 1),
    }, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
