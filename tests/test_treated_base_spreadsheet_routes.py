from treated_base_routes import column_index, column_name, normalize_range


def test_column_addresses_round_trip() -> None:
    for index, name in ((0, "A"), (25, "Z"), (26, "AA"), (701, "ZZ")):
        assert column_name(index) == name
        assert column_index(name) == index


def test_normalize_range_orders_bounds_and_counts_cells() -> None:
    result = normalize_range("D9", "B3")
    assert result == {
        "top_row": 2,
        "bottom_row": 8,
        "left_col": 1,
        "right_col": 3,
        "source_range": "B3:D9",
        "cell_count": 21,
    }
