import json
import os
import sys
import urllib.request

DESKCTL_DIR = os.environ.get("TAB_GUARD_DESKCTL_DIR")
if DESKCTL_DIR:
    sys.path.insert(0, DESKCTL_DIR)
from deskctl import windows  # noqa: E402

CHROMIUM_EXE = os.environ.get("CHROMIUM_EXE", r"\chromium\application\chrome.exe").lower()
PORT = os.environ.get("TAB_GUARD_CDP_PORT", "9222")


def resolve(spec):
    if isinstance(spec, str) and spec.startswith("point:"):
        x, y = (int(v) for v in spec[6:].split(","))
        return windows.info(windows.root_of(windows.WindowFromPoint(windows.W.POINT(x, y))))
    if spec in (None, "", "foreground"):
        return windows.info(windows.foreground())
    return windows.resolve(spec)


def main():
    specs = json.loads(sys.argv[1])
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=1.5) as r:
            pages = [t for t in json.load(r) if t.get("type") == "page"]
    except Exception:
        pages = []
    out = []
    for spec in specs:
        try:
            w = resolve(spec)
        except Exception as e:
            out.append({"spec": spec, "error": str(e)})
            continue
        root = windows.root_of(w.hwnd) or w.hwnd
        rw = windows.info(root)
        chromium = CHROMIUM_EXE in (rw.path or "").lower()
        dialog = windows.class_name(w.hwnd) == "#32770"
        tabs = [t["id"] for t in pages
                if rw.title in (f"{t.get('title', '')} - Chromium", t.get("title"))
                or (t.get("title") and rw.title.startswith(t["title"] + " - "))]
        out.append({"spec": spec, "hwnd": hex(w.hwnd), "root": hex(root), "rect": list(rw.rect), "title": rw.title,
                    "chromium": chromium, "dialog": dialog, "tabs": tabs})
    print(json.dumps(out))


main()
