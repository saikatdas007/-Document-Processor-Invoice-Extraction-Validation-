from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
import os

# ... existing code ...

# Ensure the URL starts with postgresql://
SQLALCHEMY_DATABASE_URL = os.getenv("DATABASE_URL")

# Remove: connect_args={"check_same_thread": False}
engine = create_engine(
    SQLALCHEMY_DATABASE_URL
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# ... rest of file ...

