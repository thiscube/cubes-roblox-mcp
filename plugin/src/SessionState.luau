--!nonstrict
-- Lightweight per-session state that biases read ranking.
--
-- Right now it tracks which instances mutate has touched and how recently, so
-- reads can float "the thing I was just working on" to the top of the page.

local SessionState = {}

SessionState.modified = {} -- Instance -> sequence number (higher = more recent)
SessionState._seq = 0

-- Weak keys: when an instance is deleted in Studio (not via mutate), we don't
-- want it pinned in this map forever. With __mode = "k", GC drops the entry
-- as soon as no other strong reference remains.
setmetatable(SessionState.modified, { __mode = "k" })

-- Record that an instance was just created or modified.
function SessionState.touch(inst)
	SessionState._seq += 1
	SessionState.modified[inst] = SessionState._seq
end

-- Drop tracking for an instance (e.g. when it's destroyed).
function SessionState.forget(inst)
	SessionState.modified[inst] = nil
end

-- Recency of an instance: 0 if never touched, else its sequence number.
function SessionState.recency(inst)
	return SessionState.modified[inst] or 0
end

return SessionState
