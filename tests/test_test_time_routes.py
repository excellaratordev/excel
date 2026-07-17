from test_time_unlimited import column_index, column_name, normalize_range


def test_test_time_column_addresses_round_trip() -> None:
    for index, name in ((0, "A"), (25, "Z"), (26, "AA"), (701, "ZZ")):
        assert column_name(index) == name
        assert column_index(name) == index


def test_test_time_range_normalizes_reverse_selection() -> None:
    assert normalize_range("D9", "B3") == {
        "top_row": 2,
        "bottom_row": 8,
        "left_col": 1,
        "right_col": 3,
        "reference": "B3:D9",
        "cell_count": 21,
    }


def test_test_time_group_has_no_cell_limit() -> None:
    result = normalize_range("A1", "ZZ1000000")
    assert result["reference"] == "A1:ZZ1000000"
    assert result["cell_count"] == 702_000_000
