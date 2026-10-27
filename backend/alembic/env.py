"""Alembic migrations. The database URL comes from KALISI_DATABASE_URL (see kalisi/config.py), not alembic.ini."""
from logging.config import fileConfig

from alembic import context
from geoalchemy2 import alembic_helpers
from sqlalchemy import engine_from_config, pool

from kalisi import models  # noqa: F401  (registers tables)
from kalisi.config import get_settings
from kalisi.db import Base

config = context.config
config.set_main_option("sqlalchemy.url", get_settings().database_url)
if config.config_file_name is not None:
    fileConfig(config.config_file_name)
target_metadata = Base.metadata


def include_object(obj, name, type_, reflected, compare_to):
    """Only manage Kalisi's own tables. PostGIS images can add tables of their own (e.g. the tiger geocoder's
    zcta5, edges, faces…) to the database; those must never be reported as drift or dropped by a migration.
    Trade-off: a table removed from the models must be dropped by a hand-written migration."""
    if type_ == "table" and reflected and name not in target_metadata.tables:
        return False
    if type_ == "index" and reflected and getattr(getattr(obj, "table", None), "name", None) not in target_metadata.tables:
        return False
    return alembic_helpers.include_object(obj, name, type_, reflected, compare_to)


def _opts() -> dict:
    return dict(target_metadata=target_metadata, include_object=include_object,
                process_revision_directives=alembic_helpers.writer, render_item=alembic_helpers.render_item)


def run_migrations_offline() -> None:
    context.configure(url=config.get_main_option("sqlalchemy.url"), literal_binds=True, dialect_opts={"paramstyle": "named"}, **_opts())
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(config.get_section(config.config_ini_section, {}), prefix="sqlalchemy.", poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(connection=connection, **_opts())
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
