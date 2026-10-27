"""Phone OTP sign-in and role-based access.

In dev (KALISI_ENV=dev) the OTP is returned in the API response so demos work without SMS. Demo accounts use
numbers starting 00, which are not valid Indian mobile numbers, so a misconfigured SMS provider can never text
a real person. In prod those numbers are refused and an SMS provider must be wired into `send_sms`.
"""
import datetime as dt
import hashlib
import hmac
import re
import secrets

import jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .config import get_settings
from .db import get_db
from .models import OtpCode, User

UTC = dt.timezone.utc
OTP_TTL = dt.timedelta(minutes=5)
OTP_MAX_ATTEMPTS = 5
OTP_MAX_PER_10_MIN = 3


def normalize_phone(raw: str) -> str:
    digits = re.sub(r"\D", "", raw or "")
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    if len(digits) != 10:
        raise HTTPException(422, "Enter a 10-digit mobile number")
    if digits.startswith("00"):
        if not get_settings().is_dev:
            raise HTTPException(422, "Demo numbers are disabled")
    elif digits[0] not in "6789":
        raise HTTPException(422, "Indian mobile numbers start with 6, 7, 8 or 9")
    return "+91" + digits


def _hash(phone: str, code: str) -> str:
    return hmac.new(get_settings().jwt_secret.encode(), f"{phone}:{code}".encode(), hashlib.sha256).hexdigest()


def send_sms(phone: str, text: str) -> None:
    raise HTTPException(503, "No SMS provider is configured")


def request_otp(db: Session, phone: str) -> str:
    since = dt.datetime.now(UTC) - dt.timedelta(minutes=10)
    recent = db.scalar(select(func.count()).select_from(OtpCode).where(OtpCode.phone == phone, OtpCode.created_at >= since))
    # the seeded demo accounts (control room 00000 0xxxx, demo rider 00000 1xxxx, drivers 00000 2xxxx) are signed into
    # repeatedly during demos, so they skip the limit in dev
    demo = get_settings().is_dev and phone[:9] in ("+91000000", "+91000001", "+91000002")
    if recent >= OTP_MAX_PER_10_MIN and not demo:
        raise HTTPException(429, "Too many codes requested. Try again in a few minutes.")
    code = f"{secrets.randbelow(10**6):06d}"
    db.add(OtpCode(phone=phone, code_hash=_hash(phone, code), expires_at=dt.datetime.now(UTC) + OTP_TTL))
    db.commit()
    if not get_settings().is_dev:
        send_sms(phone, f"{code} is your Kalisi sign-in code. It expires in 5 minutes.")
    return code


def verify_otp(db: Session, phone: str, code: str) -> None:
    otp = db.scalar(select(OtpCode).where(OtpCode.phone == phone, OtpCode.used.is_(False))
                    .order_by(OtpCode.created_at.desc()).limit(1))
    if otp is None or otp.expires_at < dt.datetime.now(UTC):
        raise HTTPException(401, "Code expired. Request a new one.")
    otp.attempts += 1
    if otp.attempts > OTP_MAX_ATTEMPTS:
        otp.used = True
        db.commit()
        raise HTTPException(401, "Too many wrong attempts. Request a new code.")
    if not hmac.compare_digest(otp.code_hash, _hash(phone, code.strip())):
        db.commit()
        raise HTTPException(401, "Wrong code")
    otp.used = True
    db.commit()


def issue_token(user: User) -> str:
    s = get_settings()
    exp = dt.datetime.now(UTC) + dt.timedelta(days=s.jwt_days)
    return jwt.encode({"sub": str(user.id), "role": user.role, "exp": exp}, s.jwt_secret, algorithm="HS256")


_bearer = HTTPBearer(auto_error=False)


def current_user(cred: HTTPAuthorizationCredentials | None = Depends(_bearer), db: Session = Depends(get_db)) -> User:
    if cred is None:
        raise HTTPException(401, "Sign in required")
    try:
        claims = jwt.decode(cred.credentials, get_settings().jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(401, "Session expired. Sign in again.")
    user = db.get(User, int(claims["sub"]))
    if user is None:
        raise HTTPException(401, "Account not found")
    return user


def require(*roles: str):
    def dep(user: User = Depends(current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(403, "Not allowed for this account")
        return user
    return dep
