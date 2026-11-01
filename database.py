import os
import json
from datetime import datetime
from sqlalchemy import create_engine, Column, String, Float, Text, DateTime, JSON
from sqlalchemy.orm import declarative_base, sessionmaker
from sentence_transformers import SentenceTransformer
import numpy as np

# SQLite database file stored locally in your project folder
DATABASE_URL = "sqlite:///./invoices.db"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# Load lightweight embedding model for semantic search
embedding_model = SentenceTransformer('all-MiniLM-L6-v2')

class DocumentModel(Base):
    __tablename__ = "documents"
    
    doc_id = Column(String, primary_key=True, index=True)
    filename = Column(String, nullable=False)
    status = Column(String, default="queued") # queued, processing, completed, failed
    validation_status = Column(String, nullable=True) # VALID, FLAGGED FOR MANUAL REVIEW
    extracted_text = Column(Text, nullable=True)
    structured_data = Column(JSON, nullable=True)
    validation_issues = Column(JSON, nullable=True)
    processing_history = Column(JSON, nullable=True) # Audit trail
    embedding = Column(JSON, nullable=True) # Vector embedding for semantic search
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

def init_db():
    """Creates the SQLite database tables if they do not exist."""
    Base.metadata.create_all(bind=engine)

def get_db_session():
    """Context manager or dependency for getting a database session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def save_or_update_document(doc_id, filename, status, validation_status=None, text=None, data=None, issues=None):
    """Saves or updates document metadata, results, and processing history in SQLite."""
    db = SessionLocal()
    try:
        doc = db.query(DocumentModel).filter(DocumentModel.doc_id == doc_id).first()
        
        history_entry = {
            "timestamp": datetime.utcnow().isoformat(),
            "status": status,
            "validation_status": validation_status
        }
        
        vector_embedding = None
        if text:
            vector_embedding = embedding_model.encode(text).tolist()

        if doc:
            doc.status = status
            doc.validation_status = validation_status
            doc.extracted_text = text
            doc.structured_data = data
            doc.validation_issues = issues
            history = doc.processing_history or []
            history.append(history_entry)
            doc.processing_history = history
            if vector_embedding:
                doc.embedding = vector_embedding
        else:
            doc = DocumentModel(
                doc_id=doc_id,
                filename=filename,
                status=status,
                validation_status=validation_status,
                extracted_text=text,
                structured_data=data,
                validation_issues=issues,
                processing_history=[history_entry],
                embedding=vector_embedding
            )
            db.add(doc)
        db.commit()
    finally:
        db.close()

def get_document(doc_id):
    """Retrieves a single document by its doc_id from SQLite."""
    db = SessionLocal()
    try:
        doc = db.query(DocumentModel).filter(DocumentModel.doc_id == doc_id).first()
        if not doc:
            return None
        return {
            "doc_id": doc.doc_id,
            "filename": doc.filename,
            "status": doc.status,
            "validation_status": doc.validation_status,
            "extracted_text": doc.extracted_text,
            "structured_data": doc.structured_data,
            "validation_issues": doc.validation_issues,
            "processing_history": doc.processing_history,
            "updated_at": doc.updated_at.isoformat() if doc.updated_at else None
        }
    finally:
        db.close()

def keyword_search(customer=None, invoice_number=None, status=None):
    """Performs keyword-based filtering on structured fields in SQLite."""
    db = SessionLocal()
    try:
        docs = db.query(DocumentModel).all()
        filtered = []
        for doc in docs:
            data = doc.structured_data or {}
            if customer and customer.lower() not in str(data.get("customer_name", "")).lower():
                continue
            if invoice_number and invoice_number != str(data.get("invoice_number", "")):
                continue
            if status and status != doc.validation_status:
                continue
            
            filtered.append({
                "doc_id": doc.doc_id,
                "filename": doc.filename,
                "status": doc.status,
                "validation_status": doc.validation_status,
                "structured_data": data,
                "validation_issues": doc.validation_issues
            })
        return filtered
    finally:
        db.close()

def semantic_search(query_text, top_k=3):
    """Performs vector-based semantic search over document embeddings stored in SQLite."""
    db = SessionLocal()
    try:
        docs = db.query(DocumentModel).filter(DocumentModel.embedding.isnot(None)).all()
        if not docs:
            return []
            
        query_vector = embedding_model.encode(query_text)
        scored_docs = []
        
        for doc in docs:
            doc_vector = np.array(doc.embedding)
            similarity = np.dot(query_vector, doc_vector) / (np.linalg.norm(query_vector) * np.linalg.norm(doc_vector))
            scored_docs.append((float(similarity), doc))
            
        scored_docs.sort(key=lambda x: x[0], reverse=True)
        
        return [
            {
                "doc_id": doc.doc_id,
                "score": score,
                "data": doc.structured_data
            }
            for score, doc in scored_docs[:top_k]
        ]
    finally:
        db.close()

# Initialize tables on import
init_db()