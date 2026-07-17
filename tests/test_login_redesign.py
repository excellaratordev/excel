from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LOGIN_TEMPLATE = ROOT / "templates" / "login.html"
LOGIN_CSS = ROOT / "static" / "css" / "login.css"
LOGIN_JS = ROOT / "static" / "js" / "login.js"


def test_login_template_preserves_authentication_contract():
    html = LOGIN_TEMPLATE.read_text(encoding="utf-8")

    assert 'id="google-login"' in html
    assert 'id="login-error"' in html
    assert 'id="login-title"' in html
    assert 'id="login-description"' in html
    assert "assets_api.supabase_browser_client" in html
    assert "static', filename='js/login.js'" in html
    assert "static', filename='css/login.css'" in html


def test_login_template_contains_dynamic_product_showcase():
    html = LOGIN_TEMPLATE.read_text(encoding="utf-8")

    assert 'class="login-showcase"' in html
    assert 'class="workbook-window"' in html
    assert 'class="workbook-grid"' in html
    assert "Planilhas conectadas" in html
    assert "Permissões granulares" in html
    assert "Publicação em tempo real" in html
    assert '<svg class="google-mark"' in html


def test_login_styles_are_responsive_and_accessible():
    css = LOGIN_CSS.read_text(encoding="utf-8")

    assert ".login-stage" in css
    assert "@media (max-width: 620px)" in css
    assert "@media (prefers-reduced-motion: reduce)" in css
    assert ".google-login-button:focus-visible" in css
    assert "login-cell-scan" in css


def test_login_script_keeps_safe_redirect_and_contextual_copy():
    script = LOGIN_JS.read_text(encoding="utf-8")

    assert "requested.startsWith('/')" in script
    assert "!requested.startsWith('//')" in script
    assert "greetingForHour" in script
    assert "next.startsWith('/invite/')" in script
    assert "signInWithOAuth" in script
    assert "aria-busy" in script
