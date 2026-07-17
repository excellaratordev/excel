from pathlib import Path


CSS_PATH = Path("static/css/virtual-grid.css")


def test_virtual_grid_selection_states_remain_absolutely_positioned():
    css = CSS_PATH.read_text(encoding="utf-8")
    selector = """.virtual-grid-cell.selected,
.virtual-grid-cell.selection-anchor,
.virtual-grid-cell.range-handle,
.virtual-grid-cell.editing"""
    start = css.index(selector)
    block = css[start:css.index("}", start)]

    assert "position: absolute" in block
    assert "top: 0" in block
    assert "left: 0" in block


def test_virtual_grid_nodes_have_explicit_transform_origin():
    css = CSS_PATH.read_text(encoding="utf-8")
    selector = """.virtual-grid-cell,
.virtual-grid-row-header,
.virtual-grid-col-header,
.virtual-grid-corner"""
    start = css.index(selector)
    block = css[start:css.index("}", start)]

    assert "position: absolute" in block
    assert "top: 0" in block
    assert "left: 0" in block
