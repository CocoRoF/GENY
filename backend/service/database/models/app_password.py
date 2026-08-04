"""
App Password Model — per-device secrets for protocol clients (WebDAV).

Mount clients (RaiDrive, rclone, Finder, Windows Explorer) speak HTTP
Basic, not Bearer. Rather than teaching them our JWT — impossible — each
device gets its own generated secret the user pastes as the Basic
password. Individually revocable, so losing a laptop doesn't mean
rotating the account password.

Only the SHA-256 of the secret is stored. The secret itself is 26+ chars
of CSPRNG output (~130 bits), so an offline attack on the hash is
hopeless without bcrypt's cost — and bcrypt at DAV request rates
(PROPFIND storms hit dozens of times per second) would burn ~100 ms per
request. High-entropy token + fast hash + constant-time compare is the
same trade GitHub PATs make.
"""
from typing import Dict, List
from service.database.models.base_model import BaseModel


class AppPasswordModel(BaseModel):
    """One protocol secret for one device/client."""

    def __init__(
        self,
        username: str = "",
        label: str = "",
        secret_hash: str = "",
        prefix: str = "",
        last_used_at: str = "",
        **kwargs,
    ):
        super().__init__(**kwargs)
        self.username = username
        self.label = label
        self.secret_hash = secret_hash
        # First characters of the secret, shown in the management list so a
        # user can tell entries apart without us keeping the secret.
        self.prefix = prefix
        # created_at is OWNED BY BaseModel (real TIMESTAMP, auto-set,
        # isoformat-parsed on read) — redefining it as VARCHAR here broke
        # every find_* with "Invalid isoformat string". last_used_at stays
        # a VARCHAR like AdminUserModel.last_login_at: only
        # created_at/updated_at get datetime parsing in from_dict.
        self.last_used_at = last_used_at

    def get_table_name(self) -> str:
        return "app_passwords"

    def get_schema(self) -> Dict[str, str]:
        return {
            "username": "VARCHAR(100) NOT NULL",
            "label": "VARCHAR(200) DEFAULT ''",
            "secret_hash": "VARCHAR(64) NOT NULL",
            "prefix": "VARCHAR(12) DEFAULT ''",
            "last_used_at": "VARCHAR(100) DEFAULT ''",
        }

    def get_indexes(self) -> List[tuple]:
        return [
            ("idx_app_passwords_username", "username"),
            ("idx_app_passwords_hash", "secret_hash"),
        ]
