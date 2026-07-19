from pathlib import Path

path = Path("wasm-engine/src/lib.rs")
source = path.read_text(encoding="utf-8")

if "pub const ABI_VERSION: u32 = 2;" in source:
    source = source.replace("pub const ABI_VERSION: u32 = 2;", "pub const ABI_VERSION: u32 = 3;", 1)
elif "pub const ABI_VERSION: u32 = 3;" not in source:
    raise SystemExit("ABI_VERSION esperada não encontrada")

marker = "use std::sync::atomic::{AtomicUsize, Ordering};\n"
if "mod workbook;" not in source:
    if marker not in source:
        raise SystemExit("marcador de imports não encontrado")
    source = source.replace(marker, marker + "\nmod workbook;\n", 1)

path.write_text(source, encoding="utf-8")
