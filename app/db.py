"""PostgreSQL access: connection pool, schema bootstrap, cursor helper."""
import logging
import os
import time
from contextlib import contextmanager

import psycopg2
from psycopg2.extras import RealDictCursor
from psycopg2.pool import ThreadedConnectionPool

from .config import Config

log = logging.getLogger("blueeye.db")

_pool = None


def _init_pool():
    global _pool
    if _pool is None:
        _pool = ThreadedConnectionPool(1, 10, dsn=Config.DATABASE_URL)
    return _pool


@contextmanager
def get_conn():
    pool = _init_pool()
    conn = pool.getconn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        pool.putconn(conn)


@contextmanager
def get_cursor():
    """Yield a dict cursor inside a transaction."""
    with get_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            yield cur


def init_schema(retries=30, delay=2):
    """Apply schema.sql, waiting for the database to accept connections."""
    schema_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "schema.sql"
    )
    with open(schema_path) as fh:
        schema_sql = fh.read()

    last_error = None
    for attempt in range(1, retries + 1):
        try:
            with get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute(schema_sql)
            log.info("database schema ready")
            return
        except psycopg2.OperationalError as exc:
            last_error = exc
            log.warning("database not ready (attempt %d/%d): %s", attempt, retries, exc)
            time.sleep(delay)
    raise RuntimeError(f"could not initialize database: {last_error}")
