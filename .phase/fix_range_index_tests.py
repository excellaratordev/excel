from pathlib import Path

path = Path('wasm-engine/src/lib.rs')
source = path.read_text(encoding='utf-8')
source = source.replace(
    'fn abi_is_version_four() {\n        assert_eq!(superexcel_abi_version(), 4);\n    }',
    'fn abi_is_version_five() {\n        assert_eq!(superexcel_abi_version(), 5);\n    }',
    1,
)
source = source.replace(
    'assert_eq!(compiled["ir_version"], json!(1));',
    'assert_eq!(compiled["ir_version"], json!(2));',
    1,
)
path.write_text(source, encoding='utf-8')
