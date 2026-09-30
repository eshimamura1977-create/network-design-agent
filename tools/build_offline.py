"""Developer-only build. End users need neither Python nor a server."""
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from agent.pipeline import Architecture, Delivery, Review, RULES
from agent.design_report import Draft, CHAPTERS

payload = dict(schemas={"architecture": Architecture.model_json_schema(), "design": Draft.model_json_schema(),
                        "delivery": Delivery.model_json_schema(), "review": Review.model_json_schema()},
               rules=RULES, chapters=[{"key": c[0], "title": c[1]} for c in CHAPTERS])
# Browser validation does not instantiate Pydantic defaults. Request explicit
# empty arrays/nulls so a schema-valid answer is also safe for all consumers.
def require_properties(value):
    if isinstance(value, dict):
        if value.get("type") == "object" and "properties" in value:
            value["required"] = list(value["properties"])
        for nested in value.values():
            require_properties(nested)
    elif isinstance(value, list):
        for nested in value:
            require_properties(nested)

require_properties(payload["schemas"])
(ROOT / "offline/schema.js").write_text("'use strict';\nconst NWSchemas=" + json.dumps(payload, ensure_ascii=False) +
    ";\nif(typeof module!=='undefined')module.exports=NWSchemas;\n", encoding="utf-8")
if "--schemas-only" not in sys.argv:
    (ROOT / "dist").mkdir(exist_ok=True)
    output = ROOT / "dist/network-design-browser.zip"
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted((ROOT / "offline").rglob("*")):
            if path.is_file(): archive.write(path, "network-design-browser/" + path.relative_to(ROOT / "offline").as_posix())
    print(output)
