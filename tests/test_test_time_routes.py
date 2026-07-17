from test_time_routes import column_index, column_name, normalize_range


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


def test_test_time_group_limit_is_enforced() -> None:
    try:
        normalize_range("A1", "Z500")
    except ValueError as error:
        assert "10.000" in str(error)
    else:
        raise AssertionError("A seleção acima do limite deveria ser rejeitada.")
