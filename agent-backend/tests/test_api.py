from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_check() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_chat_endpoint() -> None:
    response = client.post(
        "/api/v1/chat",
        json={"message": "你好小鲸娘", "session_id": "test-session"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["session_id"] == "test-session"
    assert "你好小鲸娘" in payload["reply"]
    assert payload["action"]["motion"] == "attention/wave hand 1"
