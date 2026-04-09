"""Dependency injection for the open-source local version. No authentication."""

from dataclasses import dataclass


@dataclass
class LocalUser:
    id: str = "local"
    username: str = "local"
    email: str = "local@localhost"
    role: str = "admin"
    nickname: str = "local"
    name: str = "local"
    avatar_url: str | None = None

    def get(self, key: str, default=None):
        if key in type(self).__dataclass_fields__:
            return getattr(self, key)
        return default

    def __getitem__(self, key: str):
        if key in type(self).__dataclass_fields__:
            return getattr(self, key)
        raise KeyError(key)


_local_user = LocalUser()


async def get_current_user() -> LocalUser:
    return _local_user


async def require_auth() -> LocalUser:
    return _local_user


async def require_admin() -> LocalUser:
    return _local_user
