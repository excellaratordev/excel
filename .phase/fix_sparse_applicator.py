from pathlib import Path

path = Path(__file__).with_name("apply_sparse_range_runtime.py")
text = path.read_text(encoding="utf-8")
text = text.replace(
    "fn abi_is_version_four() {\\n        assert_eq!(superexcel_abi_version(), 5);\\n    }",
    "fn abi_is_version_five() {\\n        assert_eq!(superexcel_abi_version(), 5);\\n    }",
)
text = text.replace(
    "test('runtime Rust/Wasm com IR compacta usa ABI 5', () => assert.equal(ABI_VERSION, 5));",
    "test('runtime Rust/Wasm com índice de intervalos usa ABI 5', () => assert.equal(ABI_VERSION, 5));",
)
text = text.replace(
    "'    assert \"range_index\" in workbook_source\\n'",
    "'    assert \"range_buckets\" in workbook_source\\n'",
)
text = text.replace(
    "'    assert \"range_index\" in workbook_source\\n    assert \"occupied_cells\" in workbook_source\\n",
    "'    assert \"range_buckets\" in workbook_source\\n    assert \"occupied_cells\" in workbook_source\\n",
)
text = text.replace(
    'integration = replace_once(integration, "tests: 19,", "tests: 21,", "Node test count")',
    'integration = replace_once(integration, "tests: 20,", "tests: 22,", "Node test count")',
)
old = """    '''  ranges: {
    descriptors: largeStats.range_dependencies,
    buckets: largeStats.range_buckets,
  },''',
    '''  ranges: {
    descriptors: largeStats.range_dependencies,
    buckets: largeStats.range_buckets,
    sparse_evaluations: sparseStats.sparse_range_evaluations,
    positions_avoided: sparseStats.range_positions_avoided,
    streamed_positions: sparseStats.streamed_range_positions,
  },''',"""
new = """    '''    range_buckets: largeStats.range_buckets,
  },''',
    '''    range_buckets: largeStats.range_buckets,
    sparse_evaluations: sparseStats.sparse_range_evaluations,
    positions_avoided: sparseStats.range_positions_avoided,
    streamed_positions: sparseStats.streamed_range_positions,
  },''',"""
if old not in text:
    raise RuntimeError("integration output marker not found in applicator")
text = text.replace(old, new, 1)
path.write_text(text, encoding="utf-8")
