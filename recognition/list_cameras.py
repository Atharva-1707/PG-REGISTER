#!/usr/bin/env python3
"""Which camera number is which?

    python3 list_cameras.py           # lists every camera that answers
    python3 list_cameras.py --show    # also opens each one in a window, numbered

On a laptop the built-in camera is usually 0 and a webcam you plug in becomes
1, but Windows sometimes hands the numbers out the other way round. Run this
with the external webcam plugged in, then put the numbers in recognition/.env:

    CAMERA_1_SOURCE=0
    CAMERA_2_SOURCE=1

It doesn't matter much if you guess wrong: the register's Swap button trades
which camera watches the entrance and which watches the outside.
"""

from __future__ import annotations

import argparse
import sys


def probe(index: int):
    import cv2

    cap = None
    if sys.platform == "win32":
        # DirectShow opens USB webcams that the default backend struggles with.
        cap = cv2.VideoCapture(index, cv2.CAP_DSHOW)
        if not cap.isOpened():
            cap.release()
            cap = None
    if cap is None:
        cap = cv2.VideoCapture(index)
    if not cap.isOpened():
        cap.release()
        return None
    ok, frame = cap.read()
    cap.release()
    if not ok or frame is None:
        return None
    h, w = frame.shape[:2]
    return w, h


def show(index: int, seconds: float = 4.0) -> None:
    import time

    import cv2

    cap = cv2.VideoCapture(index, cv2.CAP_DSHOW) if sys.platform == "win32" else cv2.VideoCapture(index)
    if not cap.isOpened():
        return
    end = time.time() + seconds
    title = f"camera {index}  (any key to skip)"
    try:
        while time.time() < end:
            ok, frame = cap.read()
            if not ok:
                break
            cv2.putText(frame, f"CAMERA {index}", (20, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (0, 255, 255), 3)
            cv2.imshow(title, frame)
            if cv2.waitKey(30) != -1:
                break
    except cv2.error:
        print("  (this OpenCV build has no windows — it is the headless one; skip --show)")
    finally:
        cap.release()
        try:
            cv2.destroyAllWindows()
        except cv2.error:
            pass


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--show", action="store_true", help="open each camera in a window for a few seconds")
    p.add_argument("--max", type=int, default=6, help="how many numbers to try (default 6)")
    args = p.parse_args()

    try:
        import cv2  # noqa: F401
    except ImportError:
        sys.exit("pip install opencv-python-headless   (or opencv-python, for --show)")

    found = []
    for i in range(args.max):
        size = probe(i)
        if size:
            found.append(i)
            print(f"  camera {i}: working, {size[0]}x{size[1]}")
            if args.show:
                show(i)
        else:
            print(f"  camera {i}: nothing there")

    if not found:
        print("\nNo camera answered. Check the cable, and that no other app (Teams, Zoom,\nthe Windows Camera app) has it open — only one program can use a camera at a time.")
        return 1
    if len(found) == 1:
        print(f"\nOnly camera {found[0]} answered. Plug the second camera in and run this again.")
    else:
        print(f"\nPut these in recognition/.env:\n  CAMERA_1_SOURCE={found[0]}\n  CAMERA_2_SOURCE={found[1]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
