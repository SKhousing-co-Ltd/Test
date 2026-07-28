#!/usr/bin/env python3
"""Local-only first-time importer and approval tool for lease-plan PDFs.

The source PDFs never leave the chosen OneDrive folder.  Review data, page
previews, white-plan candidates and every approval decision live under
outputs/contract_plan_importer (which is gitignored).
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote, urlencode, unquote, parse_qs, urlparse
from urllib.request import Request, urlopen

from PIL import Image
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "outputs" / "contract_plan_importer"
DB = WORK / "review.sqlite3"
ASSETS = WORK / "assets"
STATIC = Path(__file__).with_name("contract_plan_importer.html")
SESSION: dict[str, str] = {}
PDFTOPPM = Path(r"C:\Users\本庄幸人\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\poppler\Library\bin\pdftoppm.exe")
NODE = Path(r"C:\Users\本庄幸人\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe")
CONTRACT_WORDS = ("賃貸借契約", "貸室賃貸借", "定期建物賃貸借")


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def connect() -> sqlite3.Connection:
    WORK.mkdir(parents=True, exist_ok=True)
    ASSETS.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    db.executescript("""
    pragma foreign_keys = on;
    create table if not exists source_file (
      id text primary key, root_path text not null, relative_path text not null,
      sha256 text not null unique, modified_at text not null, size integer not null,
      classification text not null, tenant_name text, floor_label text, processed_at text not null
    );
    create table if not exists plan_candidate (
      id text primary key, source_file_id text not null references source_file(id), page_number integer not null,
      property_name text, floor_label text, tenant_name text, source_preview_path text,
      white_plan_path text, ocr_text text, confidence real not null, status text not null default 'pending',
      white_plan_status text not null default 'pending', created_at text not null,
      unique(source_file_id, page_number)
    );
    create table if not exists unit_candidate (
      id text primary key, plan_candidate_id text not null references plan_candidate(id), unit_code text,
      geometry_json text, confidence real not null, status text not null default 'pending',
      rejection_reason text, created_at text not null, updated_at text not null
    );
    create table if not exists audit_log (
      id text primary key, entity_type text not null, entity_id text not null, action text not null,
      payload_json text not null, actor text not null, created_at text not null
    );
    """)
    return db


def log(db: sqlite3.Connection, kind: str, entity: str, action: str, payload: dict[str, Any], actor: str = "local-reviewer") -> None:
    db.execute("insert into audit_log values (?, ?, ?, ?, ?, ?, ?)",
               (str(uuid.uuid4()), kind, entity, action, json.dumps(payload, ensure_ascii=False), actor, now()))


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def classify(path: Path) -> str:
    name = str(path)
    if "駐車場" in name:
        return "parking"
    if "退去済み" in name:
        return "former_tenant"
    return "lease_contract" if any(word in path.name for word in CONTRACT_WORDS) else "other"


def folder_metadata(root: Path, path: Path) -> tuple[str | None, str | None]:
    relative = path.relative_to(root)
    parts = relative.parts[:-1]
    for part in reversed(parts):
        match = re.search(r"(?P<floor>\d+(?:[・･/]\d+)?)\s*F\s*(?P<tenant>.+)", part, re.I)
        if match:
            return match.group("floor").replace("･", "・") + "F", match.group("tenant").strip()
    return None, None


def page_image(page: Any) -> Image.Image | None:
    """Use the largest embedded raster. This supports the scanned contracts in scope."""
    choices: list[Image.Image] = []
    try:
        for image in page.images:
            try:
                from io import BytesIO
                value = Image.open(BytesIO(image.data)).convert("RGB")
                choices.append(value.copy())
            except Exception:
                continue
    except Exception:
        return None
    return max(choices, key=lambda i: i.width * i.height, default=None)


def rendered_page(pdf: Path, page_number: int) -> Image.Image | None:
    """Render the complete page so vector annotations (the red leased area) remain."""
    tmp = WORK / "tmp"; tmp.mkdir(parents=True, exist_ok=True)
    token = str(uuid.uuid4()); copied = tmp / f"{token}.pdf"; prefix = tmp / token
    try:
        shutil.copy2(pdf, copied)
        subprocess.run([str(PDFTOPPM), "-f", str(page_number), "-l", str(page_number), "-r", "150", "-png", str(copied), str(prefix)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=45)
        output = tmp / f"{token}-{page_number}.png"
        return Image.open(output).convert("RGB").copy() if output.exists() else None
    except Exception:
        return None
    finally:
        copied.unlink(missing_ok=True)
        for item in tmp.glob(f"{token}-*.png"): item.unlink(missing_ok=True)


def crop_plan(image: Image.Image, boxes: list[dict[str, Any]]) -> tuple[Image.Image, list[dict[str, Any]]]:
    # Prefer the half containing a coloured lease-area annotation. This avoids
    # presenting a restoration schedule as if it were a floor plan.
    width, height = image.size; side = "left"
    if boxes:
        ring = boxes[0]["coordinates"][0][0]
        side = "right" if sum(p[0] for p in ring) / len(ring) > .5 else "left"
    crop = (width // 2, 0, width, height) if side == "right" else (0, 0, width // 2, height)
    converted: list[dict[str, Any]] = []
    for box in boxes:
        ring = box["coordinates"][0][0]
        if (side == "left" and all(point[0] <= .55 for point in ring)) or (side == "right" and all(point[0] >= .45 for point in ring)):
            shifted = [[point[0] * 2 if side == "left" else point[0] * 2 - 1, point[1]] for point in ring]
            converted.append({"type": "MultiPolygon", "coordinates": [[shifted]], "confidence": box["confidence"]})
    return image.crop(crop), converted


def colored_boxes(image: Image.Image) -> list[dict[str, Any]]:
    """Find large coloured annotations. Deliberately conservative: no shape is guessed."""
    thumb = image.copy(); thumb.thumbnail((500, 500))
    px = thumb.load(); width, height = thumb.size
    marked: set[tuple[int, int]] = set()
    for y in range(height):
        for x in range(width):
            r, g, b = px[x, y]
            if max(r, g, b) - min(r, g, b) > 55 and max(r, g, b) < 245:
                marked.add((x, y))
    boxes: list[dict[str, Any]] = []
    while marked:
        start = marked.pop(); stack = [start]; points = [start]
        while stack:
            x, y = stack.pop()
            for p in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if p in marked:
                    marked.remove(p); stack.append(p); points.append(p)
        if len(points) < 80:
            continue
        xs, ys = zip(*points); x1, x2, y1, y2 = min(xs), max(xs), min(ys), max(ys)
        if (x2 - x1) * (y2 - y1) < 250:
            continue
        ring = [[x1 / width, y1 / height], [x2 / width, y1 / height], [x2 / width, y2 / height], [x1 / width, y2 / height], [x1 / width, y1 / height]]
        boxes.append({"type": "MultiPolygon", "coordinates": [[ring]], "confidence": min(.85, .35 + len(points) / 5000)})
    return boxes[:20]


def make_white_candidate(image: Image.Image) -> Image.Image:
    # A review preview does not need archival resolution; keeping it bounded also
    # makes an initial import of hundreds of scan pages practical.
    out = image.copy(); out.thumbnail((1400, 1400)); px = out.load()
    for y in range(out.height):
        for x in range(out.width):
            r, g, b = px[x, y]
            if max(r, g, b) - min(r, g, b) > 55 and max(r, g, b) < 245:
                px[x, y] = (255, 255, 255)
    return out


def ocr(image_path: Path) -> str:
    if NODE.exists():
        try:
            output = subprocess.run([str(NODE), str(Path(__file__).with_name("ocr_local.mjs")), str(image_path)], capture_output=True, text=True, timeout=90, cwd=ROOT)
            if output.returncode == 0:
                return json.loads(output.stdout).get("text", "").strip()
        except Exception:
            pass
    executable = shutil.which("tesseract")
    if not executable:
        return ""
    try:
        return subprocess.run([executable, str(image_path), "stdout", "-l", "jpn+eng"], capture_output=True, text=True, timeout=60).stdout.strip()
    except Exception:
        return ""


def scan(root: Path, property_name: str, all_pages: bool = False) -> dict[str, int]:
    db = connect(); added = pages = 0
    for path in root.rglob("*.pdf"):
        kind = classify(path)
        if kind != "lease_contract":
            continue
        digest = sha256(path); existing = db.execute("select id from source_file where sha256 = ?", (digest,)).fetchone()
        if existing:
            continue
        floor, tenant = folder_metadata(root, path); file_id = str(uuid.uuid4())
        stat = path.stat()
        db.execute("insert into source_file values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                   (file_id, str(root), str(path.relative_to(root)), digest, datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(), stat.st_size, kind, tenant, floor, now()))
        try:
            reader = PdfReader(str(path))
        except Exception as exc:
            log(db, "source_file", file_id, "read_error", {"message": str(exc)}); continue
        # Annex drawings are conventionally at the end of these contracts.  The
        # last two pages are reviewed by default; use separate source files when
        # an older contract has drawings elsewhere rather than processing every
        # personal-information page unnecessarily.
        first_page = 0 if all_pages else max(0, len(reader.pages) - 2)
        for number in range(first_page, len(reader.pages)):
            page = reader.pages[number]
            page_number = number + 1
            image = rendered_page(path, page_number) or page_image(page)
            if not image:
                continue
            image, boxes = crop_plan(image, colored_boxes(image))
            candidate_id = str(uuid.uuid4()); folder = ASSETS / candidate_id; folder.mkdir()
            source_path = folder / "source.png"; white_path = folder / "white.png"
            image.save(source_path, "PNG"); make_white_candidate(image).save(white_path, "PNG")
            text = ocr(source_path)
            confidence = .25 + (.2 if boxes else 0) + (.15 if text else 0)
            db.execute("insert into plan_candidate values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', ?)",
                       (candidate_id, file_id, page_number, property_name, floor, tenant, str(source_path.relative_to(WORK)), str(white_path.relative_to(WORK)), text, confidence, now()))
            inferred = re.findall(r"\(([^)]*\d[^)]*)\)", path.stem)
            codes = [c for item in inferred for c in re.split(r"[・･,、/]", item) if re.fullmatch(r"\d{1,4}", c.strip())]
            for index, box in enumerate(boxes or [{}]):
                code = codes[index] if index < len(codes) else (codes[0] if len(codes) == 1 else None)
                geometry = box.get("type") and {"type": box["type"], "coordinates": box["coordinates"]}
                unit_id = str(uuid.uuid4())
                db.execute("insert into unit_candidate values (?, ?, ?, ?, ?, 'pending', null, ?, ?)",
                           (unit_id, candidate_id, code, json.dumps(geometry) if geometry else None, box.get("confidence", .15), now(), now()))
            log(db, "plan_candidate", candidate_id, "created", {"source": str(path), "page": page_number, "boxes": len(boxes)})
            pages += 1
        added += 1; db.commit()
    db.commit(); db.close(); return {"files": added, "pages": pages}


def refresh_renderings() -> dict[str, int]:
    db = connect(); count = 0
    candidates = db.execute("select p.*, s.root_path, s.relative_path from plan_candidate p join source_file s on s.id=p.source_file_id").fetchall()
    for candidate in candidates:
        pdf = Path(candidate["root_path"]) / candidate["relative_path"]
        image = rendered_page(pdf, candidate["page_number"])
        if not image: continue
        image, boxes = crop_plan(image, colored_boxes(image)); folder = WORK / Path(candidate["source_preview_path"]).parent
        image.save(WORK / candidate["source_preview_path"], "PNG"); make_white_candidate(image).save(WORK / candidate["white_plan_path"], "PNG")
        db.execute("update plan_candidate set ocr_text=? where id=?", (ocr(WORK / candidate["source_preview_path"]), candidate["id"]))
        db.execute("update plan_candidate set status=?, confidence=? where id=?", ("pending" if boxes else "not_plan", .75 if boxes else .05, candidate["id"]))
        db.execute("delete from unit_candidate where plan_candidate_id=?", (candidate["id"],))
        for box in boxes or [{}]:
            db.execute("insert into unit_candidate values (?, ?, null, ?, ?, 'pending', null, ?, ?)", (str(uuid.uuid4()), candidate["id"], json.dumps({"type": box["type"], "coordinates": box["coordinates"]}) if box else None, box.get("confidence", .15), now(), now()))
        count += 1
    db.commit(); db.close(); return {"pages": count}


def rows(db: sqlite3.Connection) -> list[dict[str, Any]]:
    items = db.execute("""select p.*, s.relative_path from plan_candidate p join source_file s on s.id=p.source_file_id where p.status <> 'not_plan'
                       order by p.floor_label, p.tenant_name, p.page_number""").fetchall()
    result = []
    for p in items:
        item = dict(p); item["units"] = [dict(u) for u in db.execute("select * from unit_candidate where plan_candidate_id=?", (p["id"],))]
        for u in item["units"]: u["geometry"] = json.loads(u.pop("geometry_json")) if u.get("geometry_json") else None
        result.append(item)
    return result


def json_response(handler: SimpleHTTPRequestHandler, value: Any, status: int = 200) -> None:
    body = json.dumps(value, ensure_ascii=False).encode("utf-8")
    handler.send_response(status); handler.send_header("Content-Type", "application/json; charset=utf-8"); handler.send_header("Content-Length", str(len(body))); handler.end_headers(); handler.wfile.write(body)


def app_env() -> dict[str, str]:
    values: dict[str, str] = {}
    path = ROOT / ".env.local"
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1); values[key.strip()] = value.strip()
    return values


class App(SimpleHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/" or self.path.startswith("/?"):
            data = STATIC.read_bytes(); self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8"); self.end_headers(); self.wfile.write(data); return
        if self.path == "/api/candidates":
            db = connect(); data = rows(db); db.close(); return json_response(self, data)
        if self.path == "/api/session": return json_response(self, {"authenticated": bool(SESSION.get("access_token"))})
        if self.path.startswith("/api/base-plan"):
            if not SESSION.get("access_token"):
                return json_response(self, {"error": "既存システムへのログインが必要です"}, 401)
            query = parse_qs(urlparse(self.path).query)
            property_name = query.get("property_name", [""])[0]
            floor_label = query.get("floor_label", [""])[0]
            if not property_name or not floor_label:
                return json_response(self, {"error": "物件とフロアを指定してください"}, 400)
            env = app_env(); url = env.get("VITE_SUPABASE_URL"); key = env.get("VITE_SUPABASE_ANON_KEY")
            try:
                token = SESSION["access_token"]
                property_query = urlencode({"select": "property_id,property_name", "property_name": f"eq.{property_name}"})
                properties = supabase_request(f"{url.rstrip('/')}/rest/v1/property_master?{property_query}", token, "GET", api_key=key)
                if len(properties) != 1:
                    return json_response(self, {"error": "物件が見つかりません"}, 404)
                property_id = properties[0]["property_id"]
                plan_query = urlencode({"select": "floor_plan_id,property_id,floor_label", "property_id": f"eq.{property_id}", "floor_label": f"eq.{floor_label}"})
                plans = supabase_request(f"{url.rstrip('/')}/rest/v1/floor_plan?{plan_query}", token, "GET", api_key=key)
                if len(plans) != 1:
                    return json_response(self, {"error": "指定フロアのベース平面図が見つかりません"}, 404)
                revision_query = urlencode({"select": "floor_plan_revision_id,preview_file_path,original_file_path,file_type,revision_no", "floor_plan_id": f"eq.{plans[0]['floor_plan_id']}", "is_current": "eq.true", "limit": "1"})
                revisions = supabase_request(f"{url.rstrip('/')}/rest/v1/floor_plan_revision?{revision_query}", token, "GET", api_key=key)
                if not revisions:
                    return json_response(self, {"error": "ベース平面図の版が見つかりません"}, 404)
                revision = revisions[0]; path = revision["preview_file_path"]
                image_url = f"{url.rstrip('/')}/storage/v1/object/floor-plans/{quote(path, safe='/')}"
                image_request = Request(image_url, method="GET", headers={"Authorization": f"Bearer {token}", "apikey": key or ""})
                with urlopen(image_request, timeout=60) as response:
                    image_bytes = response.read(); content_type = response.headers.get("Content-Type", "image/png")
                return json_response(self, {"property_id": property_id, "floor_plan_id": plans[0]["floor_plan_id"], "revision_id": revision["floor_plan_revision_id"], "floor_label": floor_label, "preview_data": "data:" + content_type + ";base64," + base64.b64encode(image_bytes).decode("ascii"), "preview_file_path": path})
            except Exception as exc:
                return json_response(self, {"error": "ベース平面図の取得に失敗しました", "detail": str(exc)}, 502)
        if self.path.startswith("/assets/"):
            # Database paths are stored relative to WORK as assets/<id>/...;
            # the URL prefix is only a routing prefix and must not be added twice.
            target = (WORK / unquote(self.path.removeprefix("/assets/")).replace("\\", "/")).resolve()
            if WORK.resolve() not in target.parents or not target.is_file: return self.send_error(404)
            self.send_response(200); self.send_header("Content-Type", "image/png"); self.end_headers(); self.wfile.write(target.read_bytes()); return
        return self.send_error(404)

    def do_POST(self) -> None:
        if self.path == "/api/login":
            length = int(self.headers.get("Content-Length", "0")); payload = json.loads(self.rfile.read(length))
            env = app_env(); url, key = env.get("VITE_SUPABASE_URL"), env.get("VITE_SUPABASE_ANON_KEY")
            if not url or not key: return json_response(self, {"error": "既存システムの接続設定がありません。"}, 500)
            try:
                result = supabase_request(f"{url.rstrip('/')}/auth/v1/token?grant_type=password", key, "POST", json.dumps({"email": payload.get("email"), "password": payload.get("password")}).encode(), api_key=key)
                SESSION["access_token"] = result["access_token"]
                return json_response(self, {"authenticated": True})
            except Exception:
                return json_response(self, {"error": "ログイン情報を確認してください。"}, 401)
        if self.path not in {"/api/unit", "/api/plan"}: return self.send_error(404)
        length = int(self.headers.get("Content-Length", "0")); payload = json.loads(self.rfile.read(length))
        if self.path == "/api/plan":
            if payload.get("status") not in {"pending", "approved", "rejected", "needs_review"}:
                return json_response(self, {"error": "invalid request"}, 400)
            db = connect(); plan = db.execute("select id from plan_candidate where id=?", (payload.get("id"),)).fetchone()
            if not plan: db.close(); return json_response(self, {"error": "not found"}, 404)
            db.execute("update plan_candidate set white_plan_status=?, status=? where id=?", (payload["status"], payload["status"], payload["id"]))
            log(db, "plan_candidate", payload["id"], "white_plan_" + payload["status"], {})
            db.commit(); db.close(); return json_response(self, {"ok": True})
        required = {"id", "status"}
        if not required <= payload.keys() or payload["status"] not in {"pending", "approved", "rejected", "needs_review"}:
            return json_response(self, {"error": "invalid request"}, 400)
        db = connect(); unit = db.execute("select * from unit_candidate where id=?", (payload["id"],)).fetchone()
        if not unit: db.close(); return json_response(self, {"error": "not found"}, 404)
        geometry = payload.get("geometry", json.loads(unit["geometry_json"]) if unit["geometry_json"] else None)
        db.execute("update unit_candidate set unit_code=?, geometry_json=?, status=?, rejection_reason=?, updated_at=? where id=?",
                   (payload.get("unit_code", unit["unit_code"]), json.dumps(geometry, ensure_ascii=False) if geometry else None, payload["status"], payload.get("reason"), now(), unit["id"]))
        log(db, "unit_candidate", unit["id"], payload["status"], {"geometry": geometry, "reason": payload.get("reason")})
        db.commit(); db.close(); return json_response(self, {"ok": True})


def serve(port: int) -> None:
    server = ThreadingHTTPServer(("127.0.0.1", port), App)
    print(f"Review tool: http://127.0.0.1:{port}")
    server.serve_forever()


def approved_plans() -> list[dict[str, Any]]:
    db = connect(); data = rows(db); db.close()
    return [plan for plan in data if plan["white_plan_status"] == "approved" and any(u["status"] == "approved" for u in plan["units"])]


def supabase_request(url: str, token: str, method: str, body: bytes | None = None, content_type: str = "application/json", api_key: str | None = None) -> Any:
    headers = {"Authorization": f"Bearer {token}", "Content-Type": content_type}
    if api_key: headers["apikey"] = api_key
    request = Request(url, data=body, method=method, headers=headers)
    with urlopen(request, timeout=60) as response:
        raw = response.read()
    return json.loads(raw) if raw else None


def register_approved(url: str, token: str, apply: bool) -> dict[str, Any]:
    """Register approved plans through the existing user-authenticated RPCs.

    The function is deliberately dry-run by default.  It requires a normal
    logged-in user's Supabase access token, so created_by/audit fields continue
    to identify the person approving this initial import.
    """
    plans = approved_plans()
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for plan in plans:
        grouped.setdefault((plan["property_name"], plan["floor_label"]), []).append(plan)
    preview: list[dict[str, Any]] = []
    for (property_name, floor), items in grouped.items():
        if len(items) != 1:
            raise ValueError(f"{property_name} / {floor}: 採用白図面は1件だけにしてください")
        units = [u for u in items[0]["units"] if u["status"] == "approved"]
        if any(not u["unit_code"] or not u["geometry"] for u in units):
            raise ValueError(f"{property_name} / {floor}: 承認区画に区画番号または座標がありません")
        preview.append({"property_name": property_name, "floor_label": floor, "unit_codes": [u["unit_code"] for u in units], "candidate_id": items[0]["id"]})
    if not apply:
        return {"mode": "dry-run", "floors": preview, "message": "--apply を指定するまでSupabaseへは書き込みません。"}
    if not url or not token:
        raise ValueError("SUPABASE_URL と SUPABASE_ACCESS_TOKEN が必要です")
    db = connect(); registered = []
    try:
        for item in preview:
            property_query = urlencode({"select": "property_id", "property_name": f"eq.{item['property_name']}"})
            properties = supabase_request(f"{url.rstrip('/')}/rest/v1/property_master?{property_query}", token, "GET")
            if len(properties) != 1: raise ValueError(f"物件マスタを一意に特定できません: {item['property_name']}")
            property_id = properties[0]["property_id"]
            plan = next(p for p in plans if p["id"] == item["candidate_id"])
            object_root = f"initial-import/{plan['id']}"
            for key, local in (("original.png", plan["source_preview_path"]), ("preview.png", plan["white_plan_path"])):
                data = (WORK / local).read_bytes()
                supabase_request(f"{url.rstrip('/')}/storage/v1/object/floor-plans/{quote(object_root + '/' + key)}", token, "POST", data, "image/png")
            revision = supabase_request(f"{url.rstrip('/')}/rest/v1/rpc/create_floor_plan_revision", token, "POST", json.dumps({
                "p_property_id": property_id, "p_building_wing_id": None, "p_floor_label": item["floor_label"],
                "p_original_file_path": object_root + "/original.png", "p_preview_file_path": object_root + "/preview.png", "p_file_type": "png", "p_pdf_page_number": None,
            }).encode())
            unit_query = urlencode({"select": "unit_id,unit_code", "property_id": f"eq.{property_id}", "floor_label": f"eq.{item['floor_label']}", "unit_code": "in.(" + ",".join(item["unit_codes"]) + ")"})
            master_units = supabase_request(f"{url.rstrip('/')}/rest/v1/unit_master?{unit_query}", token, "GET")
            unit_ids = {row["unit_code"]: row["unit_id"] for row in master_units}
            for unit in [u for u in plan["units"] if u["status"] == "approved"]:
                if unit["unit_code"] not in unit_ids: raise ValueError(f"区画マスタがありません: {item['property_name']} / {item['floor_label']} / {unit['unit_code']}")
                supabase_request(f"{url.rstrip('/')}/rest/v1/rpc/save_unit_plan_geometry", token, "POST", json.dumps({
                    "p_revision_id": revision, "p_unit_id": unit_ids[unit["unit_code"]], "p_geometry_geojson": unit["geometry"], "p_note": "契約書図面初回登録ツールで承認",
                }).encode())
            log(db, "plan_candidate", plan["id"], "supabase_registered", {"revision_id": revision, "units": item["unit_codes"]})
            registered.append({**item, "revision_id": revision})
        db.commit()
    finally:
        db.close()
    return {"mode": "applied", "floors": registered}


def main() -> None:
    parser = argparse.ArgumentParser(description="Local lease-plan first-time import tool")
    sub = parser.add_subparsers(dest="command", required=True)
    p_scan = sub.add_parser("scan"); p_scan.add_argument("folder", type=Path); p_scan.add_argument("--property-name", required=True); p_scan.add_argument("--all-pages", action="store_true", help="全ページを候補化（既定は末尾2ページ）")
    p_serve = sub.add_parser("serve"); p_serve.add_argument("--port", type=int, default=8765)
    sub.add_parser("refresh-renderings")
    p_export = sub.add_parser("export-approved"); p_export.add_argument("--output", type=Path, default=WORK / "approved_registration.json")
    p_register = sub.add_parser("register-approved"); p_register.add_argument("--apply", action="store_true"); p_register.add_argument("--supabase-url", default=os.getenv("SUPABASE_URL", "")); p_register.add_argument("--access-token", default=os.getenv("SUPABASE_ACCESS_TOKEN", ""))
    args = parser.parse_args()
    if args.command == "scan":
        if not args.folder.is_dir(): parser.error("folder must exist")
        print(json.dumps(scan(args.folder, args.property_name, args.all_pages), ensure_ascii=False))
    elif args.command == "serve": serve(args.port)
    elif args.command == "refresh-renderings": print(json.dumps(refresh_renderings(), ensure_ascii=False))
    elif args.command == "register-approved":
        print(json.dumps(register_approved(args.supabase_url, args.access_token, args.apply), ensure_ascii=False, indent=2))
    else:
        db = connect(); data = rows(db); db.close()
        approved = [{k: v for k, v in plan.items() if k != "units"} | {"units": [u for u in plan["units"] if u["status"] == "approved"]} for plan in data if plan["white_plan_status"] == "approved"]
        approved = [p for p in approved if p["units"]]
        args.output.parent.mkdir(parents=True, exist_ok=True); args.output.write_text(json.dumps(approved, ensure_ascii=False, indent=2), encoding="utf-8")
        print(args.output)


if __name__ == "__main__":
    main()
