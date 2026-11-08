# ... existing imports ...

class User(Base):
    __tablename__ = "users"
    
    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True)
    # Ensure standard types; Postgres will handle these as BOOLEAN and TIMESTAMP
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    
# ... rest of code ...
