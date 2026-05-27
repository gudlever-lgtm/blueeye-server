"""Minimal SMTP sender."""
import logging
import smtplib
from email.message import EmailMessage

from .config import settings

log = logging.getLogger("blueeye.mailer")


def send_email(to: str, subject: str, body: str) -> None:
    if not settings.SMTP_HOST:
        log.warning("SMTP not configured; would have sent to %s: %s", to, subject)
        log.info("Email body:\n%s", body)
        return
    msg = EmailMessage()
    msg["From"] = settings.SMTP_FROM
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)
    try:
        with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT) as smtp:
            smtp.starttls()
            if settings.SMTP_USER:
                smtp.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
            smtp.send_message(msg)
    except Exception as exc:
        log.error("failed to send email to %s: %s", to, exc)


def send_password_reset(to: str, token: str) -> None:
    url = f"{settings.PUBLIC_BASE_URL.rstrip('/')}/reset-password?token={token}"
    body = (
        "A password reset was requested for your BlueEye account.\n\n"
        f"Open this link within one hour to set a new password:\n{url}\n\n"
        "If you did not request a reset, you can ignore this email."
    )
    send_email(to, "BlueEye password reset", body)
