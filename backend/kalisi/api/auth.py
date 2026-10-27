from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import clock
from ..config import get_settings
from ..db import get_db
from ..models import Driver, Duty, User
from ..security import current_user, issue_token, normalize_phone, request_otp, verify_otp

router = APIRouter(prefix="/auth", tags=["auth"])


class OtpRequest(BaseModel):
    phone: str


class OtpVerify(BaseModel):
    phone: str
    code: str = Field(min_length=4, max_length=8)
    name: str | None = Field(default=None, max_length=80)


def user_dict(u: User) -> dict:
    return {"id": u.id, "name": u.name, "role": u.role, "phone": u.phone}


@router.post("/otp")
def send_code(body: OtpRequest, db: Session = Depends(get_db)):
    phone = normalize_phone(body.phone)
    code = request_otp(db, phone)
    return {"sent": True, "phone": phone, **({"dev_code": code} if get_settings().is_dev else {})}


@router.post("/verify")
def verify(body: OtpVerify, db: Session = Depends(get_db)):
    phone = normalize_phone(body.phone)
    verify_otp(db, phone, body.code)
    user = db.scalar(select(User).where(User.phone == phone))
    if user is None:
        user = User(phone=phone, name=(body.name or "").strip(), role="rider")
        db.add(user)
        db.commit()
    elif body.name and not user.name:
        user.name = body.name.strip()
        db.commit()
    return {"token": issue_token(user), "user": user_dict(user)}


@router.get("/me")
def me(user: User = Depends(current_user)):
    return user_dict(user)


@router.get("/demo-accounts")
def demo_accounts(db: Session = Depends(get_db)):
    """Dev only: accounts to try each app with. Drivers listed are those with a duty today."""
    if not get_settings().is_dev:
        raise HTTPException(404)
    today = clock.today(db)
    out = [{"role": u.role, "name": u.name, "phone": u.phone[3:], "note": ""} for u in
           db.execute(select(User).where(User.phone.like("+9100000%"), User.role != "driver").order_by(User.id)).scalars()]
    for d, duty in db.execute(select(Driver, Duty).join(Duty, Duty.driver_id == Driver.id).where(Duty.service_date == today)
                              .order_by(Duty.report_at).limit(8)).all():
        out.append({"role": "driver", "name": d.user.name, "phone": d.user.phone[3:],
                    "note": f"{duty.vehicle.reg_no} · {duty.block.lower()} · reports {duty.report_at.astimezone(clock.tz()):%H:%M}"})
    return out
