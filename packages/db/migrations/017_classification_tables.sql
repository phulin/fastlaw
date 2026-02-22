CREATE TABLE usc_classifications (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	congress INTEGER NOT NULL,
	public_law_number TEXT NOT NULL,
	pub_law_sec TEXT,
	usc_title TEXT,
	usc_section TEXT,
	description TEXT,
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	UNIQUE (congress, public_law_number, pub_law_sec, usc_title, usc_section) ON CONFLICT REPLACE
);

CREATE INDEX idx_usc_classifications_lookup
ON usc_classifications (congress, public_law_number, pub_law_sec);
