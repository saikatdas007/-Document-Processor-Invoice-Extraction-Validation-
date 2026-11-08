from sqlalchemy import (
    create_engine,
    Column,
    Integer,
    String,
    Float,
    Text,
    DateTime,
    Boolean
)

from sqlalchemy.orm import (
    declarative_base,
    sessionmaker
)

from datetime import datetime


# ==================================================
# PostgreSQL Connection
# ==================================================

DATABASE_URL = (
    "postgresql+psycopg2://postgres:44332211@localhost:5432/document_processor"
)

engine = create_engine(
    DATABASE_URL,
    echo=True
)

SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine
)

Base = declarative_base()


# ==================================================
# Documents
# ==================================================

class Document(Base):

    __tablename__ = "documents"

    id = Column(
        Integer,
        primary_key=True,
        autoincrement=True
    )

    filename = Column(
        String(255),
        nullable=False
    )

    status = Column(
        String(50),
        default="processed"
    )

    extracted_text = Column(
        Text
    )

    created_at = Column(
        DateTime,
        default=datetime.utcnow
    )


# ==================================================
# Invoices
# ==================================================

class Invoice(Base):

    __tablename__ = "invoices"

    id = Column(
        Integer,
        primary_key=True,
        autoincrement=True
    )

    invoice_number = Column(
        String(100)
    )

    supplier_name = Column(
        String(255)
    )

    invoice_date = Column(
        String(100)
    )

    subtotal = Column(
        Float
    )

    tax = Column(
        Float
    )

    total = Column(
        Float
    )

    currency = Column(
        String(20)
    )

    created_at = Column(
        DateTime,
        default=datetime.utcnow
    )


# ==================================================
# Users
# ==================================================

class User(Base):

    __tablename__ = "users"

    user_id = Column(
        Integer,
        primary_key=True,
        autoincrement=True
    )

    email = Column(
        String(320),
        unique=True,
        nullable=False
    )

    password_hash = Column(
        Text,
        nullable=False
    )

    role = Column(
        String(20),
        default="viewer"
    )

    is_active = Column(
        Boolean,
        default=True
    )

    created_at = Column(
        DateTime,
        default=datetime.utcnow
    )


# ==================================================
# Auth Attempts
# ==================================================

class AuthAttempt(Base):

    __tablename__ = "auth_attempts"

    attempt_key = Column(
        String(255),
        primary_key=True
    )

    attempts = Column(
        Integer,
        default=0
    )

    window_started_at = Column(
        Float
    )


# ==================================================
# Document Embeddings
# ==================================================

class DocumentEmbedding(Base):

    __tablename__ = "document_embeddings"

    doc_id = Column(
        String(255),
        primary_key=True
    )

    embedding = Column(
        Text,
        nullable=False
    )


# ==================================================
# Processing Events
# ==================================================

class DocumentProcessingEvent(Base):

    __tablename__ = "document_processing_events"

    event_id = Column(
        Integer,
        primary_key=True,
        autoincrement=True
    )

    doc_id = Column(
        String(255),
        nullable=False
    )

    processed_at = Column(
        DateTime,
        default=datetime.utcnow
    )


# ==================================================
# Create Tables
# ==================================================

Base.metadata.create_all(bind=engine)


# ==================================================
# Database Session
# ==================================================

def get_db():

    db = SessionLocal()

    try:
        yield db

    finally:
        db.close()


# ==================================================
# Run Directly
# ==================================================

if __name__ == "__main__":

    Base.metadata.create_all(bind=engine)

    print("✅ PostgreSQL setup completed successfully")