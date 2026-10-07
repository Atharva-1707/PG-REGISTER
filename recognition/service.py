#!/usr/bin/env python3
"""Entrance recognition service. Runs continuously on the mini PC.

    python3 service.py                 # live camera(s)
    python3 service.py --source clip.mp4 --no-post --window   # dry run
    python3 service.py --source in.mp4 --source2 out.mp4 --no-post   # two-camera dry run

One camera (CAMERA_SOURCE) reads the walking direction from how the face box
grows. Two cameras (CAMERA_1_SOURCE / CAMERA_2_SOURCE) don't need to: the
entrance camera faces the PG door from inside, so whoever it recognises is
coming IN; the outside camera faces away from the door, so whoever it
recognises is going OUT. The dashboard's Swap button trades the two jobs.

Pipeline, per pass rather than per frame:

    grab frame -> downscale -> MOTION GATE -> detect faces -> IoU-track
      -> on track end: pick sharpest crop, embed once, 1:N match
      -> infer direction from how the face box grew
      -> cooldown check -> POST to the backend (queued if it's down)

Two things make this fit on a fanless N100:

  * The motion gate. Detection costs ~100ms a frame; a frame difference on an
    80x60 thumbnail costs microseconds. A doorway is empty most of the day, so
    most frames never reach the detector at all. This is the big one.
  * Embedding once per track rather than once per frame for the register.

The live view the warden watches is sent only while someone is actually
looking at it — see PreviewSender. Nobody watching costs nothing.
"""

from __future__ import annotations

import argparse
import base64
import json
import logging
import os
import signal
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from core import (
    Cooldown,
    CrossCameraGuard,
    MotionGate,
    Observation,
    Tracker,
    build_overlay,
    check_liveness,
    identify,
    l2_normalize,
    load_env_file,
    load_gallery,
    role_for_camera,
    sharpness,
    track_direction,
)

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
QUEUE_FILE = DATA / "pending_events.json"
EMBEDDINGS_FILE = DATA / "embeddings.json"

log = logging.getLogger("recognition")


_auth_warned = False


def warn_auth(code: int) -> None:
    """A 401 is a setup mistake, not a network blip — say so, once, plainly."""
    global _auth_warned
    if code in (401, 403) and not _auth_warned:
        _auth_warned = True
        log.error(
            "the register rejected our SERVICE_TOKEN (HTTP %s). Make it identical in "
            "backend/.env and recognition/.env, then restart both. Until then the live "
            "view stays blank and movements are not recorded.",
            code,
        )


def http_json(url: str, token: str, payload: dict | None = None, timeout: float = 4.0):
    """One request, returning parsed JSON or None. Never raises."""
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-Service-Token"] = token
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url, data=data, headers=headers, method="POST" if data else "GET"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode("utf-8", "replace")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        warn_auth(e.code)
        return None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return None


class Config:
    """Everything tunable, from the environment. See .env.example."""

    def __init__(self, args):
        # --- cameras ------------------------------------------------------
        # Cam 1 / Cam 2 are physical cameras, named by where they plug in.
        # What each one *does* (watch the entrance, or watch the outside) is
        # the dashboard's Swap setting, not something fixed here.
        #   --source / --source2     a dry run against recordings
        #   CAMERA_1_SOURCE, _2_     two live cameras (or one, with the other to follow)
        #   CAMERA_SOURCE            the original single camera, direction from the face box
        source2 = getattr(args, "source2", None)
        env1 = os.getenv("CAMERA_1_SOURCE", "").strip()
        env2 = os.getenv("CAMERA_2_SOURCE", "").strip()
        self.sources: dict[str, str] = {}
        if args.source is not None:
            self.sources["1"] = str(args.source)
            if source2 is not None:
                self.sources["2"] = str(source2)
            self.role_driven = source2 is not None
        elif env1 or env2:
            if env1:
                self.sources["1"] = env1
            if env2:
                self.sources["2"] = env2
            self.role_driven = True
        else:
            self.sources["1"] = os.getenv("CAMERA_SOURCE", "0")
            self.role_driven = False
        self.source = self.sources.get("1", "")  # the single-camera name, kept for old callers
        # Only used until the register answers; the dashboard's choice wins after that.
        self.swapped_default = os.getenv("CAMERAS_SWAPPED", "0") == "1"
        self.role_poll = float(os.getenv("CAMERA_ROLE_POLL_SECONDS", "3"))
        self.camera_retry = float(os.getenv("CAMERA_RETRY_SECONDS", "10"))
        self.cross_camera_seconds = float(os.getenv("CROSS_CAMERA_SECONDS", "8"))
        # 0 leaves the camera on its own default. Two cameras at 1080p can
        # saturate a laptop's USB; 1280x720 is plenty for a face at a doorway.
        # MJPG makes a USB camera send compressed frames, which uses a fraction of
        # the bandwidth of the default raw format. Two USB cameras on one laptop
        # port controller often flicker or show blocky artifacts without it.
        self.camera_fourcc = os.getenv("CAMERA_FOURCC", "").strip().upper()[:4]
        self.camera_width = int(os.getenv("CAMERA_WIDTH", "0"))
        self.camera_height = int(os.getenv("CAMERA_HEIGHT", "0"))
        self.api = os.getenv("API_URL", "http://localhost:4000").rstrip("/")
        self.api_token = os.getenv("SERVICE_TOKEN", "")
        self.detect_width = int(os.getenv("DETECT_WIDTH", "640"))
        self.det_size = int(os.getenv("DET_SIZE", "640"))
        self.model = os.getenv("MODEL_PACK", "buffalo_l")
        self.threshold = float(os.getenv("MATCH_THRESHOLD", "0.42"))
        self.margin = float(os.getenv("MATCH_MARGIN", "0.06"))
        self.cooldown = float(os.getenv("COOLDOWN_SECONDS", "120"))
        self.min_face_px = int(os.getenv("MIN_FACE_PX", "60"))
        self.min_track_len = int(os.getenv("MIN_TRACK_FRAMES", "3"))
        # Which way the camera faces. "in" = a face growing larger is someone
        # walking in through the door. Flip if the camera watches people leave.
        self.approach_means = os.getenv("APPROACH_MEANS", "in")
        self.log_unknowns = os.getenv("LOG_UNKNOWNS", "1") == "1"

        # --- pacing -------------------------------------------------------
        # The camera may offer 30fps; a walk-past lasts a second or more, so
        # 12 is plenty and the spare cycles stay free for everything else.
        self.max_fps = float(os.getenv("MAX_FPS", "12"))

        # --- motion gate --------------------------------------------------
        self.motion_enabled = os.getenv("MOTION_GATE", "1") == "1"
        self.motion_width = int(os.getenv("MOTION_WIDTH", "80"))
        self.motion_pixel_delta = float(os.getenv("MOTION_PIXEL_DELTA", "8"))
        self.motion_min_changed = float(os.getenv("MOTION_MIN_CHANGED", "0.0035"))
        self.motion_hold_frames = int(os.getenv("MOTION_HOLD_FRAMES", "18"))
        self.motion_force_every = int(os.getenv("MOTION_FORCE_EVERY", "24"))

        # --- live view ----------------------------------------------------
        self.preview_enabled = os.getenv("LIVE_VIEW", "1") == "1"
        self.preview_fps = float(os.getenv("LIVE_VIEW_FPS", "4"))
        self.preview_width = int(os.getenv("LIVE_VIEW_WIDTH", "480"))
        self.preview_quality = int(os.getenv("LIVE_VIEW_QUALITY", "60"))

        # --- enrollment pickup --------------------------------------------
        # Re-read embeddings.json when it changes, so adding a guest in the
        # browser takes effect without anyone opening a terminal.
        self.gallery_poll = float(os.getenv("GALLERY_POLL_SECONDS", "5"))

        # Off by default — see check_liveness's docstring and the README for
        # why. Turning it on costs a color crop per observation.
        self.liveness_enabled = os.getenv("LIVENESS_ENABLED", "0") == "1"
        self.liveness_blur_floor = float(os.getenv("LIVENESS_BLUR_FLOOR", "60"))
        self.liveness_chroma_low = float(os.getenv("LIVENESS_CHROMA_LOW", "5"))
        self.liveness_chroma_high = float(os.getenv("LIVENESS_CHROMA_HIGH", "32"))
        self.liveness_glare_ceiling = float(os.getenv("LIVENESS_GLARE_CEILING", "0.12"))

        self.post = not args.no_post
        self.window = args.window  # local OpenCV window, for bench testing


class EventSender:
    """POSTs events, and survives the backend being down.

    Every event carries a client-generated event_id; the backend treats a
    repeat as a no-op, so retrying a queued event can't double-toggle a
    guest's in/out state.
    """

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.queue: deque[dict] = deque(maxlen=5000)
        self._load_queue()

    def _load_queue(self) -> None:
        if QUEUE_FILE.exists():
            try:
                self.queue.extend(json.loads(QUEUE_FILE.read_text(encoding="utf-8")))
                log.info("recovered %d queued events from disk", len(self.queue))
            except (json.JSONDecodeError, OSError) as e:
                log.warning("could not read event queue: %s", e)

    def _save_queue(self) -> None:
        DATA.mkdir(parents=True, exist_ok=True)
        try:
            tmp = QUEUE_FILE.with_suffix(".tmp")
            tmp.write_text(json.dumps(list(self.queue)), encoding="utf-8")
            tmp.replace(QUEUE_FILE)
        except OSError as e:
            log.warning("could not persist event queue: %s", e)

    def _post(self, path: str, payload: dict) -> bool:
        req = urllib.request.Request(
            f"{self.cfg.api}{path}",
            data=json.dumps(payload).encode(),
            headers={
                "Content-Type": "application/json",
                **({"X-Service-Token": self.cfg.api_token} if self.cfg.api_token else {}),
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return 200 <= r.status < 300
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                # Wrong token: a setup mistake, not a bad event. Keep the event
                # queued so fixing the token doesn't cost anyone's movements.
                warn_auth(e.code)
                return False
            # Any other 4xx is our bug, not a network blip — don't retry it forever.
            log.error("backend rejected event: %s %s", e.code, e.reason)
            return 400 <= e.code < 500
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            log.warning("backend unreachable (%s) — queued", e)
            return False

    def send(self, payload: dict, path: str = "/api/logs") -> None:
        if not self.cfg.post:
            log.info("[dry run] %s %s", path, json.dumps(payload))
            return
        self.queue.append({"path": path, "payload": payload})
        self.drain()

    def drain(self) -> None:
        sent = 0
        while self.queue:
            item = self.queue[0]
            if not self._post(item["path"], item["payload"]):
                break
            self.queue.popleft()
            sent += 1
        if sent or self.queue:
            self._save_queue()


class PreviewSender:
    """Ships the live door view to the backend, on its own thread.

    Two rules keep this off the critical path:

      * One slot, newest wins. If the network is slow the camera loop
        overwrites the pending frame instead of waiting for it. A stalled
        upload can never stall recognition.
      * Nobody watching, nothing sent. The backend says whether a browser has
        asked for a frame in the last few seconds; when none has, this falls
        back to a cheap state poll every couple of seconds and the camera loop
        skips the JPEG encode entirely.
    """

    def __init__(self, cfg: Config, cam: str = "1"):
        self.cfg = cfg
        self.cam = str(cam)  # which physical camera this picture belongs to
        self._lock = threading.Lock()
        self._slot: dict | None = None
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._wanted = False
        self._warned = False
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if not (self.cfg.preview_enabled and self.cfg.post):
            return
        self._thread = threading.Thread(target=self._run, name="live-view", daemon=True)
        self._thread.start()

    def wanted(self) -> bool:
        return self._wanted

    def offer(self, image_b64: str, faces: list[dict], width: int, height: int) -> None:
        with self._lock:
            self._slot = {
                "cam": self.cam,
                "image": image_b64,
                "faces": faces,
                "width": width,
                "height": height,
                "captured_at": datetime.now(timezone.utc).isoformat(),
            }
        self._wake.set()

    def _apply(self, reply: dict | None) -> None:
        if reply is None:
            if self._wanted and not self._warned:
                log.warning("backend unreachable — live view paused")
                self._warned = True
            self._wanted = False
            return
        self._warned = False
        self._wanted = bool(reply.get("wanted"))

    def _run(self) -> None:
        # Ask straight away rather than after the first wait, so opening the
        # live view in the browser shows a picture now and not in two seconds.
        self._apply(http_json(f"{self.cfg.api}/api/preview/state?cam={self.cam}", self.cfg.api_token, timeout=3.0))

        while not self._stop.is_set():
            self._wake.wait(timeout=2.0)
            self._wake.clear()
            if self._stop.is_set():
                break

            with self._lock:
                frame, self._slot = self._slot, None

            if frame is not None:
                self._apply(http_json(f"{self.cfg.api}/api/preview", self.cfg.api_token, frame, timeout=3.0))
            else:
                self._apply(http_json(f"{self.cfg.api}/api/preview/state?cam={self.cam}", self.cfg.api_token, timeout=3.0))

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()


class RoleWatcher:
    """Knows which camera is the entrance and which is outside right now.

    The warden's Swap button lives in the register; this asks it every few
    seconds, on its own thread, so a swap takes effect without a restart and a
    slow register can never stall a camera. If the register can't be reached the
    last known arrangement stands (and CAMERAS_SWAPPED is the first guess).
    """

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.swapped = cfg.swapped_default
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def role(self, camera_id: str) -> str:
        return role_for_camera(camera_id, self.swapped)

    def refresh(self) -> None:
        reply = http_json(f"{self.cfg.api}/api/cameras", self.cfg.api_token, timeout=2.5)
        if isinstance(reply, dict) and isinstance(reply.get("swapped"), bool):
            self.swapped = reply["swapped"]

    def start(self) -> None:
        if not (self.cfg.role_driven and self.cfg.post):
            return
        self.refresh()  # so the first frame already has the right job
        self._thread = threading.Thread(target=self._run, name="camera-roles", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.wait(self.cfg.role_poll):
            self.refresh()

    def stop(self) -> None:
        self._stop.set()


def try_open_capture(source: str, cfg: Config | None = None):
    """Open a camera, or return None. Never exits: a camera may be plugged in later."""
    import cv2

    is_index = str(source).isdigit()
    target = int(source) if is_index else source

    cap = None
    if is_index and sys.platform == "win32":
        # The default Windows backend (MSMF) is slow to open and often fails
        # outright on USB webcams that DirectShow opens instantly.
        cap = cv2.VideoCapture(target, cv2.CAP_DSHOW)
        if not cap.isOpened():
            cap.release()
            cap = None
    if cap is None:
        cap = cv2.VideoCapture(target)
    if not cap.isOpened():
        cap.release()
        return None
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)  # always read the freshest frame
    if cfg is not None and len(cfg.camera_fourcc) == 4 and not str(source).lower().startswith("rtsp"):
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*cfg.camera_fourcc))
    if cfg is not None and cfg.camera_width > 0 and cfg.camera_height > 0:
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, cfg.camera_width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, cfg.camera_height)
    return cap


def open_capture(source: str, cfg: Config | None = None):
    """Open a camera or stop with a message. For the single-camera setup."""
    cap = try_open_capture(source, cfg)
    if cap is None:
        sys.exit(
            f"could not open camera source {source!r}.\n"
            "For a USB camera try 0 or 1; for an IP camera use the full RTSP URL.\n"
            "python3 list_cameras.py shows which numbers have a camera behind them."
        )
    return cap


def build_model(cfg: Config):
    try:
        from insightface.app import FaceAnalysis
    except ImportError:
        sys.exit("pip install insightface onnxruntime opencv-python-headless")
    app = FaceAnalysis(name=cfg.model, providers=["CPUExecutionProvider"])
    app.prepare(ctx_id=-1, det_size=(cfg.det_size, cfg.det_size))
    return app


def warn_model_mismatch(gallery, cfg: Config) -> None:
    """Embeddings from another model pack never match. Say so, by name."""
    bad = sorted({g.name for g in gallery if (g.model or "buffalo_l") != cfg.model})
    if bad:
        log.error(
            "MODEL MISMATCH: %s %s enrolled with a different model than MODEL_PACK=%s, "
            "so they will always show as 'Not recognised'. Set MODEL_PACK in "
            "recognition/.env to the one they were enrolled with (buffalo_l unless you "
            "changed it), or remove and re-add them.",
            ", ".join(bad), "was" if len(bad) == 1 else "were", cfg.model,
        )


def gallery_stamp() -> float:
    """mtime of embeddings.json, or 0. Changes when a guest is enrolled."""
    try:
        return EMBEDDINGS_FILE.stat().st_mtime
    except OSError:
        return 0.0


def handle_track(
    track,
    gallery,
    cooldown: Cooldown,
    sender: EventSender,
    cfg: Config,
    camera: str | None = None,
    role: str | None = None,
    guard: CrossCameraGuard | None = None,
) -> None:
    """One completed walk-past: identify it and log it.

    With two cameras, `camera` is which one saw it and `role` what that camera
    is for right now ("in" for the entrance camera, "out" for the outside one).
    The role *is* the direction: no guessing from the face box, so nothing to
    get wrong when someone stops at the door or walks in at an angle.
    """
    if len(track.observations) < cfg.min_track_len:
        return  # a flicker, not a person

    best = track.best()
    if best.embedding is None:
        return
    if min(
        best.bbox[2] - best.bbox[0], best.bbox[3] - best.bbox[1]
    ) < cfg.min_face_px:
        return

    match = identify(best.embedding, gallery, cfg.threshold, cfg.margin)
    direction = role if role in ("in", "out") else track_direction(track, cfg.approach_means)
    where = {"camera": camera} if camera is not None else {}

    if match.accepted and cfg.liveness_enabled and best.rgb_crop is not None:
        live = check_liveness(
            best.rgb_crop,
            blur_floor=cfg.liveness_blur_floor,
            chroma_low=cfg.liveness_chroma_low,
            chroma_high=cfg.liveness_chroma_high,
            glare_ceiling=cfg.liveness_glare_ceiling,
        )
        if not live.passed:
            log.info("%s matched but failed liveness (%s) — logging as unknown", match.name, live.reason)
            if cfg.log_unknowns:
                sender.send(
                    {
                        "event_id": uuid.uuid4().hex,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "best_score": round(match.score, 4),
                        "reason": f"liveness_{live.reason}",
                        "direction": direction,
                        **where,
                    },
                    path="/api/unknown",
                )
            return

    if not match.accepted:
        log.info(
            "unknown face (best %.2f, runner-up %.2f, %s)",
            match.score,
            match.runner_up,
            match.reason,
        )
        if cfg.log_unknowns:
            sender.send(
                {
                    "event_id": uuid.uuid4().hex,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "best_score": round(match.score, 4),
                    "reason": match.reason,
                    "direction": direction,
                    **where,
                },
                path="/api/unknown",
            )
        return

    if not cooldown.allows(match.guest_id):
        log.debug(
            "%s still in cooldown (%.0fs left)",
            match.name,
            cooldown.remaining(match.guest_id),
        )
        return

    if guard is not None and camera is not None and not guard.allows(match.guest_id, camera):
        log.info(
            "%s seen by camera %s a moment after the other camera logged them — ignored",
            match.name,
            camera,
        )
        return

    cooldown.mark(match.guest_id)
    if guard is not None and camera is not None:
        guard.mark(match.guest_id, camera)
    log.info(
        "%s  %.2f  direction=%s%s",
        match.name,
        match.score,
        direction or "toggle",
        f"  (camera {camera})" if camera is not None else "",
    )
    sender.send(
        {
            "event_id": uuid.uuid4().hex,
            "guest_id": match.guest_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "confidence": round(match.score, 4),
            # None means "you decide" — the backend falls back to toggling
            # the guest's last known state.
            "direction": direction,
            "source": "camera",
            "track_frames": len(track.observations),
            **where,
        }
    )


class Channel:
    """One physical camera and everything that belongs to it alone.

    Each camera gets its own tracker, motion gate, cooldown and live-view
    sender: two doorways' worth of state must not mix, or one person walking
    past camera 1 could finish a track that started on camera 2.
    """

    def __init__(self, cam_id: str, source: str, cfg: Config):
        self.id = cam_id
        self.source = source
        self.cap = None
        self.role: str | None = None
        self.misses = 0
        self.frames = 0
        self.tracker = Tracker()
        self.cooldown = Cooldown(cfg.cooldown)
        self.gate = MotionGate(
            pixel_delta=cfg.motion_pixel_delta,
            min_changed=cfg.motion_min_changed,
            hold_frames=cfg.motion_hold_frames,
            force_every=cfg.motion_force_every,
        )
        self.preview = PreviewSender(cfg, cam_id)
        self.next_frame_at = 0.0
        self.next_open_at = 0.0
        self.last_preview_at = 0.0
        self.boxes: list[dict] = []
        self.boxes_at = 0.0
        self.tag = f"[cam {cam_id}] " if cfg.role_driven else ""


def describe_roles(role: str | None) -> str:
    return {"in": "entrance, marks IN", "out": "outside, marks OUT"}.get(role or "", "single camera")


def run(cfg: Config) -> int:
    import cv2

    gallery = load_gallery(EMBEDDINGS_FILE)
    gallery_seen = gallery_stamp()
    if not gallery:
        log.warning(
            "no enrolled guests in %s yet — watching anyway. Add a guest from "
            "the dashboard and this picks them up within %.0fs.",
            EMBEDDINGS_FILE,
            cfg.gallery_poll,
        )
    else:
        log.info("loaded %d enrolled guests", len(gallery))
        warn_model_mismatch(gallery, cfg)

    if cfg.role_driven and len(cfg.sources) == 2 and cfg.sources["1"] == cfg.sources["2"]:
        sys.exit(
            f"CAMERA_1_SOURCE and CAMERA_2_SOURCE are both {cfg.sources['1']!r}. "
            "Each camera needs its own number — python3 list_cameras.py shows them."
        )

    app = build_model(cfg)
    channels = [Channel(cid, src, cfg) for cid, src in sorted(cfg.sources.items())]
    sender = EventSender(cfg)
    guard = CrossCameraGuard(cfg.cross_camera_seconds)
    roles = RoleWatcher(cfg)
    roles.start()

    for ch in channels:
        if cfg.role_driven:
            # A camera that isn't plugged in yet must not stop the other one.
            ch.cap = try_open_capture(ch.source, cfg)
            if ch.cap is None:
                log.warning(
                    "%scould not open camera source %r — running without it and trying again "
                    "every %.0fs. Plug it in, or check the number with list_cameras.py.",
                    ch.tag, ch.source, cfg.camera_retry,
                )
                ch.next_open_at = time.time() + cfg.camera_retry
        else:
            ch.cap = open_capture(ch.source, cfg)
        ch.preview.start()

    if cfg.role_driven:
        for ch in channels:
            ch.role = roles.role(ch.id)
            log.info("camera %s (source %s) = %s", ch.id, ch.source, describe_roles(ch.role))

    stopping = False

    def stop(_sig, _frm):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    t0 = time.time()
    frame_interval = 1.0 / cfg.max_fps if cfg.max_fps > 0 else 0.0
    preview_interval = 1.0 / cfg.preview_fps if cfg.preview_fps > 0 else 0.0
    gallery_checked_at = time.time()

    while not stopping:
        now = time.time()

        # --- pacing: don't burn cycles reading faster than we process ------
        due = [ch for ch in channels if now >= ch.next_frame_at]
        if not due:
            wake = min(ch.next_frame_at for ch in channels)
            time.sleep(max(0.0, min(wake - now, 0.05)))
            continue

        # --- did the warden press Swap? -------------------------------------
        if cfg.role_driven:
            for ch in channels:
                role = roles.role(ch.id)
                if role != ch.role:
                    log.info("camera %s is now the %s camera — %s", ch.id,
                             "entrance" if role == "in" else "outside", describe_roles(role))
                    # A walk-past that began under the old job must not be
                    # logged under the new one.
                    ch.tracker = Tracker()
                    ch.role = role

        for ch in due:
            if stopping:
                break
            ch.next_frame_at = time.time() + frame_interval

            # --- a camera that isn't there (yet) ---------------------------
            if ch.cap is None:
                if time.time() >= ch.next_open_at:
                    ch.cap = try_open_capture(ch.source, cfg)
                    if ch.cap is not None:
                        log.info("%scamera source %r is now open", ch.tag, ch.source)
                        ch.misses = 0
                    else:
                        ch.next_open_at = time.time() + cfg.camera_retry
                ch.next_frame_at = time.time() + 0.25
                continue

            ok, frame = ch.cap.read()
            if not ok:
                ch.misses += 1
                if ch.misses > 60:
                    log.error("%scamera stopped delivering frames — reopening", ch.tag)
                    ch.cap.release()
                    time.sleep(2)
                    if cfg.role_driven:
                        ch.cap = try_open_capture(ch.source, cfg)
                        if ch.cap is None:
                            ch.next_open_at = time.time() + cfg.camera_retry
                    else:
                        ch.cap = open_capture(ch.source, cfg)
                    ch.misses = 0
                time.sleep(0.05)
                continue
            ch.misses = 0
            ch.frames += 1
            now = time.time()

            # --- a guest enrolled from the browser? pick them up -----------
            if now - gallery_checked_at >= cfg.gallery_poll:
                gallery_checked_at = now
                stamp = gallery_stamp()
                if stamp != gallery_seen:
                    gallery_seen = stamp
                    gallery = load_gallery(EMBEDDINGS_FILE)
                    log.info("roster changed — now matching %d guests", len(gallery))
                    warn_model_mismatch(gallery, cfg)

            scale = cfg.detect_width / frame.shape[1]
            small = (
                cv2.resize(frame, (cfg.detect_width, int(frame.shape[0] * scale)))
                if scale < 1
                else frame
            )
            gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)

            # --- motion gate: the cheap question before the expensive one --
            if cfg.motion_enabled:
                mw = cfg.motion_width
                mh = max(1, int(gray.shape[0] * (mw / gray.shape[1])))
                run_detect = ch.gate.update(cv2.resize(gray, (mw, mh)))
            else:
                run_detect = True

            observations = []
            if run_detect:
                for face in app.get(small):
                    x1, y1, x2, y2 = (float(v) for v in face.bbox)
                    crop = gray[max(0, int(y1)) : int(y2), max(0, int(x1)) : int(x2)]
                    if crop.size == 0:
                        continue
                    rgb_crop = None
                    if cfg.liveness_enabled:
                        bgr_crop = small[max(0, int(y1)) : int(y2), max(0, int(x1)) : int(x2)]
                        if bgr_crop.size > 0:
                            rgb_crop = bgr_crop[:, :, ::-1].copy()  # BGR -> RGB
                    observations.append(
                        Observation(
                            bbox=(x1, y1, x2, y2),
                            sharpness=sharpness(crop),
                            embedding=l2_normalize(face.normed_embedding.astype(np.float32)),
                            rgb_crop=rgb_crop,
                        )
                    )

            # A skipped frame is a frame with no faces in it, which is exactly
            # what the tracker should be told: tracks still age out on schedule.
            for finished in ch.tracker.update(observations):
                handle_track(
                    finished, gallery, ch.cooldown, sender, cfg,
                    camera=ch.id if cfg.role_driven else None,
                    role=ch.role if cfg.role_driven else None,
                    guard=guard if cfg.role_driven else None,
                )

            # --- live view ---------------------------------------------------
            if ch.preview.wanted() and now - ch.last_preview_at >= preview_interval:
                ch.last_preview_at = now
                if run_detect:
                    # Free: every visible face was already embedded this frame, so
                    # naming them is a few dot products against a 20-row gallery.
                    ch.boxes = build_overlay(
                        observations, gallery, small.shape[1], small.shape[0],
                        cfg.threshold, cfg.margin,
                    )
                    ch.boxes_at = now
                elif now - ch.boxes_at > 1.0:
                    ch.boxes = []  # gate skipped and the last read is stale — clear

                pw = cfg.preview_width
                pv = (
                    cv2.resize(small, (pw, max(1, int(small.shape[0] * (pw / small.shape[1])))))
                    if pw < small.shape[1]
                    else small
                )
                encoded, buf = cv2.imencode(
                    ".jpg", pv, [int(cv2.IMWRITE_JPEG_QUALITY), cfg.preview_quality]
                )
                if encoded:
                    ch.preview.offer(
                        base64.b64encode(buf.tobytes()).decode("ascii"),
                        ch.boxes,
                        pv.shape[1],
                        pv.shape[0],
                    )

            if ch.frames % 300 == 0:
                sender.drain()  # retry anything queued while the backend was down
                log.info(
                    "%s%d frames, %.1f fps, %.0f%% skipped by motion gate, %d tracks, %d queued",
                    ch.tag,
                    ch.frames,
                    ch.frames / (time.time() - t0),
                    ch.gate.skip_ratio * 100,
                    len(ch.tracker.tracks),
                    len(sender.queue),
                )

            if cfg.window:
                for o in observations:
                    x1, y1, x2, y2 = (int(v) for v in o.bbox)
                    cv2.rectangle(small, (x1, y1), (x2, y2), (0, 200, 120), 2)
                title = f"camera {ch.id} - {describe_roles(ch.role)}" if cfg.role_driven else "entrance"
                cv2.imshow(title, small)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    stopping = True

    for ch in channels:
        for finished in ch.tracker.flush():
            handle_track(
                finished, gallery, ch.cooldown, sender, cfg,
                camera=ch.id if cfg.role_driven else None,
                role=ch.role if cfg.role_driven else None,
                guard=guard if cfg.role_driven else None,
            )
    sender.drain()
    roles.stop()
    for ch in channels:
        ch.preview.stop()
        if ch.cap is not None:
            ch.cap.release()
    if cfg.window:
        cv2.destroyAllWindows()
    for ch in channels:
        log.info(
            "%sstopped after %d frames (%.0f%% skipped by the motion gate); %d events still queued",
            ch.tag,
            ch.frames,
            ch.gate.skip_ratio * 100,
            len(sender.queue),
        )
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--source", help="camera index, video file or RTSP URL")
    p.add_argument(
        "--source2",
        help="a second recording, for a two-camera dry run: --source is the entrance camera, "
        "--source2 the outside one",
    )
    p.add_argument("--no-post", action="store_true", help="log events instead of sending them")
    p.add_argument(
        "--window",
        "--preview",
        dest="window",
        action="store_true",
        help="show a local camera window (needs a display; the warden's live view is in the browser)",
    )
    p.add_argument("--verbose", action="store_true")
    args = p.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s  %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )

    # recognition/.env — CAMERA_SOURCE, API_URL, SERVICE_TOKEN and the rest.
    # Real environment variables still win over the file.
    env_file = Path(__file__).resolve().parent / ".env"
    loaded = load_env_file(env_file)
    if loaded:
        log.info("read %d settings from %s", loaded, env_file.name)
    elif not env_file.exists():
        log.warning("no %s — using defaults (camera 0, API localhost:4000, no token)", env_file)
    return run(Config(args))


if __name__ == "__main__":
    raise SystemExit(main())
