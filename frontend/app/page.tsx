'use client';

import { useState, useEffect } from 'react';
import axios from 'axios';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

export default function Dashboard() {
  const [token, setToken] = useState<string>('');
  const [email, setEmail] = useState('admin@example.com');
  const [password, setPassword] = useState('adminpassword');
  const [role, setRole] = useState<string>('');
  const [documents, setDocuments] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [chartData, setChartData] = useState([]);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadStatus, setUploadStatus] = useState('');
  const [error, setError] = useState('');

  // Handle Login
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await axios.post('http://localhost:8000/api/auth/login', {
        email,
        password,
      });
      const accessToken = res.data.access_token;
      setToken(accessToken);
      setRole(res.data.role || 'viewer');
      setError('');
      
      fetchDocuments(accessToken);
      fetchAnalytics(accessToken);
    } catch (err) {
      setError('Invalid login credentials');
    }
  };

  // Fetch Documents
  const fetchDocuments = async (currentToken: string, query = '') => {
    try {
      const url = query 
        ? `http://localhost:8000/api/documents/search?q=${query}` 
        : `http://localhost:8000/api/documents/search`;
      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${currentToken}` }
      });
      
      const data = res.data;
      if (Array.isArray(data)) {
        setDocuments(data);
      } else if (data && typeof data === 'object') {
        setDocuments(data.documents || data.items || data.results || []);
      } else {
        setDocuments([]);
      }
    } catch (err) {
      console.error('Failed to fetch documents', err);
      setDocuments([]);
    }
  };

  // Fetch Analytics Data
  const fetchAnalytics = async (currentToken: string) => {
    try {
      const res = await axios.get('http://localhost:8000/api/documents/analytics', {
        headers: { Authorization: `Bearer ${currentToken}` }
      });
      setChartData(res.data);
    } catch (err) {
      console.error('Failed to fetch analytics', err);
    }
  };

  // Handle Document Upload
  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile) return;

    const formData = new FormData();
    formData.append('file', selectedFile);

    try {
      setUploadStatus('Uploading...');
      await axios.post('http://localhost:8000/api/documents/upload', formData, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'multipart/form-data',
        },
      });
      setUploadStatus('Upload successful!');
      setSelectedFile(null);
      fetchDocuments(token);
      fetchAnalytics(token);
    } catch (err) {
      console.error('Upload failed', err);
      setUploadStatus('Upload failed. Try again.');
    }
  };

  // Handle Document Deletion (Admin Only)
  const handleDeleteDocument = async (docId: number | string) => {
    if (!confirm(`Are you sure you want to delete document #${docId}?`)) return;

    try {
      await axios.delete(`http://localhost:8000/api/documents/${docId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      fetchDocuments(token, searchQuery);
      fetchAnalytics(token);
    } catch (err) {
      console.error('Failed to delete document', err);
      alert('Failed to delete document. Ensure you have admin privileges.');
    }
  };

  // Export CSV Report
  const handleExportCSV = async () => {
    try {
      const res = await axios.get('http://localhost:8000/api/documents/export/csv', {
        headers: { Authorization: `Bearer ${token}` },
        responseType: 'blob',
      });
      const blob = new Blob([res.data], { type: 'text/csv' });
      const link = document.createElement('a');
      link.href = window.URL.createObjectURL(blob);
      link.download = 'document_report.csv';
      link.click();
    } catch (err) {
      console.error('Failed to export CSV', err);
    }
  };

  // If not logged in, show Login Screen
  if (!token) {
    return (
      <main style={{ display: 'flex', height: '100vh', justifyContent: 'center', alignItems: 'center', backgroundColor: '#0f172a', color: '#fff', fontFamily: 'sans-serif' }}>
        <form onSubmit={handleLogin} style={{ background: '#1e293b', padding: '32px', borderRadius: '12px', width: '350px', border: '1px solid #334155' }}>
          <h2 style={{ marginBottom: '20px', fontSize: '20px', fontWeight: 'bold' }}>Dashboard Login</h2>
          {error && <p style={{ color: '#ef4444', marginBottom: '15px', fontSize: '14px' }}>{error}</p>}
          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: '5px', fontSize: '14px', color: '#94a3b8' }}>Email</label>
            <input 
              type="email" 
              value={email} 
              onChange={(e) => setEmail(e.target.value)} 
              style={{ width: '100%', padding: '10px', borderRadius: '6px', background: '#0f172a', border: '1px solid #334155', color: '#fff' }}
            />
          </div>
          <div style={{ marginBottom: '20px' }}>
            <label style={{ display: 'block', marginBottom: '5px', fontSize: '14px', color: '#94a3b8' }}>Password</label>
            <input 
              type="password" 
              value={password} 
              onChange={(e) => setPassword(e.target.value)} 
              style={{ width: '100%', padding: '10px', borderRadius: '6px', background: '#0f172a', border: '1px solid #334155', color: '#fff' }}
            />
          </div>
          <button type="submit" style={{ width: '100%', padding: '10px', backgroundColor: '#38bdf8', color: '#0f172a', fontWeight: 'bold', border: 'none', borderRadius: '6px', cursor: 'pointer' }}>
            Sign In
          </button>
        </form>
      </main>
    );
  }

  // Full Dashboard View
  return (
    <main style={{ minHeight: '100vh', backgroundColor: '#0f172a', color: '#f8fafc', padding: '40px', fontFamily: 'sans-serif' }}>
      <div style={{ maxWidth: '1000px', margin: '0 auto' }}>
        
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
          <h1 style={{ fontSize: '24px', fontWeight: 'bold' }}>Document Intelligence Dashboard</h1>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <button 
              onClick={handleExportCSV} 
              style={{ padding: '8px 14px', backgroundColor: '#0ea5e9', color: '#fff', border: 'none', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer', fontSize: '13px' }}
            >
              📥 Export CSV
            </button>
            <span style={{ padding: '6px 12px', background: role === 'admin' ? '#0284c7' : '#475569', borderRadius: '20px', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>
              {role}
            </span>
          </div>
        </div>

        {/* Analytics Chart Section */}
        <section style={{ background: 'linear-gradient(145deg, #0b0f19 0%, #111827 100%)', border: '1px solid rgba(51, 65, 85, 0.6)', borderRadius: '16px', padding: '28px', marginBottom: '28px' }}>
          <h3 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '20px', color: '#f8fafc', margin: '0 0 20px 0' }}>📈 Document Processing Rate Over Time</h3>
          <div style={{ width: '100%', height: '280px' }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="date" stroke="#94a3b8" />
                <YAxis stroke="#94a3b8" />
                <Tooltip contentStyle={{ backgroundColor: '#0f172a', borderColor: '#334155', borderRadius: '8px', color: '#fff' }} />
                <Line type="monotone" dataKey="processed" stroke="#38bdf8" strokeWidth={3} dot={{ fill: '#38bdf8' }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>

        {/* Document Upload Section */}
        <section style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: '16px', padding: '28px', marginBottom: '28px' }}>
          <h3 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '16px' }}>📤 Upload New Document</h3>
          <form onSubmit={handleUpload} style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <input 
              type="file" 
              onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
              style={{ color: '#94a3b8', fontSize: '14px' }}
            />
            <button 
              type="submit" 
              style={{ padding: '8px 16px', backgroundColor: '#38bdf8', color: '#0f172a', fontWeight: 'bold', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
            >
              Upload
            </button>
            {uploadStatus && <span style={{ fontSize: '14px', color: '#38bdf8' }}>{uploadStatus}</span>}
          </form>
        </section>

        {/* Search & Documents Management Section */}
        <section style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: '16px', padding: '28px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <h3 style={{ fontSize: '16px', fontWeight: '600', margin: 0 }}>📁 Processed Documents ({documents.length})</h3>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input 
                type="text" 
                placeholder="Search documents..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{ padding: '8px 12px', borderRadius: '6px', background: '#0f172a', border: '1px solid #334155', color: '#fff', fontSize: '14px' }}
              />
              <button 
                onClick={() => fetchDocuments(token, searchQuery)}
                style={{ padding: '8px 14px', backgroundColor: '#334155', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
              >
                Search
              </button>
            </div>
          </div>

          {/* Document List */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {documents.length === 0 ? (
              <p style={{ color: '#94a3b8', fontSize: '14px' }}>No documents found.</p>
            ) : (
              documents.map((doc: any, index: number) => {
                const docId = doc.id !== undefined ? doc.id : index;
                return (
                  <div key={docId} style={{ background: '#0f172a', padding: '14px 18px', borderRadius: '8px', border: '1px solid #334155', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <p style={{ fontWeight: 'bold', margin: '0 0 4px 0' }}>{doc.filename || doc.title || `Document #${index + 1}`}</p>
                      <p style={{ color: '#94a3b8', fontSize: '12px', margin: 0 }}>ID: {docId}</p>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <span style={{ fontSize: '12px', color: '#38bdf8', background: 'rgba(56, 189, 248, 0.1)', padding: '4px 8px', borderRadius: '4px' }}>Processed</span>
                      {role === 'admin' && (
                        <button 
                          onClick={() => handleDeleteDocument(docId)}
                          style={{ background: '#ef4444', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold' }}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

      </div>
    </main>
  );
}