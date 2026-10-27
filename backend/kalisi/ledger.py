"""Double-entry ledger. Every money movement is a balanced transaction; nothing edits a balance directly.

Accounts used:
  gateway_clearing        asset: money collected by the payment gateway, not yet settled to the bank
  deferred_revenue        liability: passes sold for rides not yet delivered
  rider_credit:<user id>  liability: ride credits owed to a rider (earned by skipping before the cut-off)
"""
import uuid

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .models import LedgerEntry


class LedgerError(ValueError):
    pass


def post(db: Session, lines: list[tuple[str, int, int]], memo: str) -> str:
    """lines: (account, debit_paise, credit_paise). Raises if unbalanced. Does not commit."""
    lines = [(a, d, c) for a, d, c in lines if d or c]
    debit, credit = sum(d for _, d, _ in lines), sum(c for _, _, c in lines)
    if not lines or debit != credit:
        raise LedgerError(f"unbalanced transaction: debit {debit} != credit {credit}")
    if any(d < 0 or c < 0 or (d and c) for _, d, c in lines):
        raise LedgerError("each line must be a positive debit or a positive credit")
    txn = str(uuid.uuid4())
    db.add_all(LedgerEntry(txn_id=txn, account=a, debit_paise=d, credit_paise=c, memo=memo) for a, d, c in lines)
    return txn


def liability_balance(db: Session, account: str) -> int:
    """Credits minus debits: what is owed on a liability account, in paise."""
    q = select(func.coalesce(func.sum(LedgerEntry.credit_paise - LedgerEntry.debit_paise), 0)).where(LedgerEntry.account == account)
    return int(db.scalar(q))


def rider_account(user_id: int) -> str:
    return f"rider_credit:{user_id}"


def trial_balance(db: Session) -> int:
    """Sum of debits minus credits over the whole ledger. Must always be 0."""
    return int(db.scalar(select(func.coalesce(func.sum(LedgerEntry.debit_paise - LedgerEntry.credit_paise), 0))))
