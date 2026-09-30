-- 公開済みの版 v1.0.0 で作った DB の fixture（ADR 0344）。
-- ⛔ 手で編集しない。作り直すときは scripts/generate-upgrade-fixture.mjs を走らせる。
--
-- 作ったコード: v1.0.0（c27ca959b5fc528274e304746314d2beaa7b386b）の @mnemora/postgres / @mnemora/core / @mnemora/testkit。
-- 埋め込み: @mnemora/testkit の DeterministicEmbeddingProvider（外部 API は使っていない）。
-- 中身: すべて合成データ（秘密・個人情報を含まない）。何を入れたかは
--       scripts/generate-upgrade-fixture.mjs の冒頭を見ること。
--
--
-- PostgreSQL database dump
--


-- Dumped from database version 17.11 (Debian 17.11-0+deb13u1)
-- Dumped by pg_dump version 17.11 (Debian 17.11-0+deb13u1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: btree_gin; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS btree_gin WITH SCHEMA public;


--
-- Name: EXTENSION btree_gin; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION btree_gin IS 'support for indexing common datatypes in GIN';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: EXTENSION vector; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION vector IS 'vector data type and ivfflat and hnsw access methods';


--
-- Name: mnemora_lexical_coverage(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mnemora_lexical_coverage(content text, query text) RETURNS double precision
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT count(*) FILTER (
           WHERE to_tsvector('simple', mnemora_lexical_normalize(content)) @@ tq
         )::float8 / NULLIF(count(*), 0)
  FROM unnest(mnemora_lexical_query_tsqueries(query)) AS tq;
$$;


--
-- Name: mnemora_lexical_normalize(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mnemora_lexical_normalize(text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $_$
  SELECT regexp_replace($1, '([[:ascii:]]+)', ' \1 ', 'g');
$_$;


--
-- Name: mnemora_lexical_query_or(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mnemora_lexical_query_or(text) RETURNS tsquery
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $_$
  SELECT coalesce(
    (SELECT string_agg('(' || q::text || ')', ' | ')
       FROM unnest(mnemora_lexical_query_tsqueries($1)) AS q)::tsquery,
    ''::tsquery);
$_$;


--
-- Name: mnemora_lexical_query_terms(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mnemora_lexical_query_terms(text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $_$
  SELECT regexp_replace($1, '[^[:ascii:]]+', ' ', 'g');
$_$;


--
-- Name: mnemora_lexical_query_tsqueries(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mnemora_lexical_query_tsqueries(text) RETURNS tsquery[]
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $_$
  SELECT coalesce(array_agg(DISTINCT q), ARRAY[]::tsquery[])
  FROM (
    SELECT websearch_to_tsquery('simple', '"' || replace(t, '"', '') || '"') AS q
    FROM unnest(regexp_split_to_array(btrim(mnemora_lexical_query_terms($1)), '\s+')) AS t
    WHERE t <> ''
  ) s
  WHERE q::text <> '';
$_$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: _mnemora_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public._mnemora_migrations (
    name text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: memories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    subject_id text,
    source_observation_id uuid,
    extractor_version text,
    content text NOT NULL,
    content_hash text NOT NULL,
    digest text NOT NULL,
    digest_source text DEFAULT 'llm'::text NOT NULL,
    provenance_kind text NOT NULL,
    provenance jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    superseded_by_id uuid,
    contested_with_id uuid,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    occurred_at timestamp with time zone,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    last_reinforced_at timestamp with time zone,
    valid_from timestamp with time zone,
    valid_until timestamp with time zone,
    strength real DEFAULT 1.0 NOT NULL,
    half_life_hours real NOT NULL,
    decay_floor_at timestamp with time zone NOT NULL,
    embedding_status text DEFAULT 'pending'::text NOT NULL,
    purged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    decay_base_seq bigint,
    decay_floor_seq bigint,
    half_life_recalls real,
    CONSTRAINT memories_check CHECK (((provenance_kind <> ALL (ARRAY['stated'::text, 'inferred'::text])) OR (source_observation_id IS NOT NULL))),
    CONSTRAINT memories_decay_seq_non_negative CHECK ((((decay_base_seq IS NULL) OR (decay_base_seq >= 0)) AND ((decay_floor_seq IS NULL) OR (decay_floor_seq >= 0)))),
    CONSTRAINT memories_digest_source_check CHECK ((digest_source = ANY (ARRAY['llm'::text, 'fallback'::text]))),
    CONSTRAINT memories_embedding_status_check CHECK ((embedding_status = ANY (ARRAY['pending'::text, 'ready'::text, 'failed'::text, 'skipped'::text]))),
    CONSTRAINT memories_half_life_range CHECK (((half_life_hours > (0)::double precision) AND (half_life_hours < 'Infinity'::real))),
    CONSTRAINT memories_half_life_recalls_range CHECK (((half_life_recalls IS NULL) OR ((half_life_recalls > (0)::double precision) AND (half_life_recalls < 'Infinity'::real)))),
    CONSTRAINT memories_provenance_kind_check CHECK ((provenance_kind = ANY (ARRAY['stated'::text, 'inferred'::text, 'consolidated'::text, 'reflected'::text, 'imported'::text]))),
    CONSTRAINT memories_provenance_kind_matches_provenance CHECK ((provenance_kind = (provenance ->> 'kind'::text))),
    CONSTRAINT memories_status_check CHECK ((status = ANY (ARRAY['active'::text, 'superseded'::text, 'contested'::text, 'archived'::text, 'forgotten'::text]))),
    CONSTRAINT memories_strength_range CHECK (((strength > (0)::double precision) AND (strength <= (1)::double precision)))
);


--
-- Name: memory_embeddings_test_fixture_model_3; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_embeddings_test_fixture_model_3 (
    tenant_id text NOT NULL,
    memory_id uuid NOT NULL,
    embedding public.vector(3) NOT NULL,
    model text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: memory_embeddings_testkit_deterministic_8; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_embeddings_testkit_deterministic_8 (
    tenant_id text NOT NULL,
    memory_id uuid NOT NULL,
    embedding public.vector(8) NOT NULL,
    model text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: memory_embeddings_all_spaces; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.memory_embeddings_all_spaces AS
 SELECT memory_embeddings_test_fixture_model_3.tenant_id,
    memory_embeddings_test_fixture_model_3.memory_id,
    (memory_embeddings_test_fixture_model_3.embedding)::text AS embedding_text
   FROM public.memory_embeddings_test_fixture_model_3
UNION ALL
 SELECT memory_embeddings_testkit_deterministic_8.tenant_id,
    memory_embeddings_testkit_deterministic_8.memory_id,
    (memory_embeddings_testkit_deterministic_8.embedding)::text AS embedding_text
   FROM public.memory_embeddings_testkit_deterministic_8;


--
-- Name: memory_embeddings_small_view; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.memory_embeddings_small_view AS
 SELECT tenant_id,
    memory_id,
    embedding,
    model,
    created_at
   FROM public.memory_embeddings_test_fixture_model_3;


--
-- Name: memory_embeddings_some_very_long_provider_name_an_extr_b34ef257; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 (
    tenant_id text NOT NULL,
    memory_id uuid NOT NULL,
    embedding public.vector(4) NOT NULL,
    model text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: memory_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    memory_id uuid,
    kind text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    actor jsonb NOT NULL,
    digest_snapshot text,
    size_before_bytes integer,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT memory_events_check CHECK (((kind <> 'events_purged'::text) OR (memory_id IS NULL))),
    CONSTRAINT memory_events_kind_check CHECK ((kind = ANY (ARRAY['created'::text, 'updated'::text, 'superseded'::text, 'archived'::text, 'forgotten'::text, 'purged'::text, 'events_purged'::text, 'restored'::text, 'unsuperseded'::text])))
);


--
-- Name: observations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.observations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    subject_id text,
    external_id text,
    kind text NOT NULL,
    payload jsonb NOT NULL,
    occurred_at timestamp with time zone,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    valid_from timestamp with time zone,
    valid_until timestamp with time zone
);


--
-- Name: outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    kind text NOT NULL,
    payload jsonb NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_at timestamp with time zone,
    claimed_by text,
    attempts integer DEFAULT 0 NOT NULL,
    completed_at timestamp with time zone,
    failed_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: recall_usages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recall_usages (
    tenant_id text NOT NULL,
    recall_id uuid NOT NULL,
    memory_id uuid NOT NULL,
    used_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: recalls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recalls (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text NOT NULL,
    subject_id text,
    query jsonb NOT NULL,
    budget jsonb,
    omitted jsonb DEFAULT '[]'::jsonb NOT NULL,
    usage jsonb NOT NULL,
    index_band jsonb NOT NULL,
    explain jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    returned_memories jsonb NOT NULL
);


--
-- Name: tenant_activity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_activity (
    tenant_id text NOT NULL,
    activity_seq bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_activity_seq_non_negative CHECK ((activity_seq >= 0))
);


--
-- Name: tenant_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_settings (
    tenant_id text NOT NULL,
    default_half_life_hours real DEFAULT 720 NOT NULL,
    event_retention_days integer,
    taxonomy_mode text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    decay_clock text DEFAULT 'wall'::text NOT NULL,
    default_half_life_recalls real DEFAULT 720 NOT NULL,
    CONSTRAINT tenant_settings_decay_clock_check CHECK ((decay_clock = ANY (ARRAY['wall'::text, 'activity'::text, 'either'::text]))),
    CONSTRAINT tenant_settings_default_half_life_range CHECK (((default_half_life_hours > (0)::double precision) AND (default_half_life_hours < 'Infinity'::real))),
    CONSTRAINT tenant_settings_default_half_life_recalls_range CHECK (((default_half_life_recalls > (0)::double precision) AND (default_half_life_recalls < 'Infinity'::real))),
    CONSTRAINT tenant_settings_taxonomy_mode_check CHECK ((taxonomy_mode = ANY (ARRAY['open'::text, 'strict'::text])))
);


--
-- Data for Name: _mnemora_migrations; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public._mnemora_migrations VALUES ('0001_init.sql', '2026-09-30 16:10:28.182146+09');
INSERT INTO public._mnemora_migrations VALUES ('0002_outbox_claim_lease_index.sql', '2026-09-30 16:10:28.195537+09');
INSERT INTO public._mnemora_migrations VALUES ('0003_period_ann_stage_index.sql', '2026-09-30 16:10:28.197233+09');
INSERT INTO public._mnemora_migrations VALUES ('0004_contested_with_index.sql', '2026-09-30 16:10:28.198578+09');
INSERT INTO public._mnemora_migrations VALUES ('0005_analyze_memories.sql', '2026-09-30 16:10:28.199849+09');
INSERT INTO public._mnemora_migrations VALUES ('0006_strength_value_range.sql', '2026-09-30 16:10:28.201347+09');
INSERT INTO public._mnemora_migrations VALUES ('0007_memories_requeue_embed_index.sql', '2026-09-30 16:10:28.20263+09');
INSERT INTO public._mnemora_migrations VALUES ('0008_memories_lexical_index.sql', '2026-09-30 16:10:28.204337+09');
INSERT INTO public._mnemora_migrations VALUES ('0009_memories_lexical_or_coverage.sql', '2026-09-30 16:10:28.205857+09');
INSERT INTO public._mnemora_migrations VALUES ('0010_memory_events_retention_index.sql', '2026-09-30 16:10:28.207145+09');
INSERT INTO public._mnemora_migrations VALUES ('0011_memory_events_kind_restored.sql', '2026-09-30 16:10:28.208316+09');
INSERT INTO public._mnemora_migrations VALUES ('0012_half_life_hours_range.sql', '2026-09-30 16:10:28.21064+09');
INSERT INTO public._mnemora_migrations VALUES ('0013_recall_returned_memories_jsonb.sql', '2026-09-30 16:10:28.211587+09');
INSERT INTO public._mnemora_migrations VALUES ('0014_observations_valid_from_until.sql', '2026-09-30 16:10:28.21284+09');
INSERT INTO public._mnemora_migrations VALUES ('0015_decay_activity_clock.sql', '2026-09-30 16:10:28.213582+09');
INSERT INTO public._mnemora_migrations VALUES ('0016_provenance_kind_matches_provenance.sql', '2026-09-30 16:10:28.216524+09');
INSERT INTO public._mnemora_migrations VALUES ('0017_provenance_kind_matches_provenance_validate.sql', '2026-09-30 16:10:28.217554+09');
INSERT INTO public._mnemora_migrations VALUES ('0018_memory_events_kind_unsuperseded.sql', '2026-09-30 16:10:28.218368+09');


--
-- Data for Name: memories; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.memories VALUES ('385ddb84-f30d-45b6-a610-a90f4fa542da', 'tenant-a', NULL, 'f99381d3-2ff9-42d8-b89c-cb65bd5555ab', 'v1', 'tenant-a の記憶 1 東京 会議 プロジェクト1', 'ed6b6174b16e829904eb19e37af61bcdac066ad24d037aab65ab91746f903e4e', 'tenant-a の記憶 1 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.253Z", "kind": "stated", "speaker": "user", "sourceObservationId": "f99381d3-2ff9-42d8-b89c-cb65bd5555ab"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.255+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:45.876+09', 'ready', NULL, '2026-09-30 16:10:28.256191+09', '2026-09-30 16:10:28.368115+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('cdaec7f7-e905-4944-bea0-efbd5313f206', 'tenant-a', NULL, 'd91ffdbc-7a8f-4d90-8533-7ac380bf84f5', 'v1', 'tenant-a の記憶 2 東京 会議 プロジェクト2', 'd5783633ec67bfa023b1656bde0eda60589e932b2e5eb00bad51d9366c647db5', 'tenant-a の記憶 2 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.259Z", "kind": "stated", "speaker": "user", "sourceObservationId": "d91ffdbc-7a8f-4d90-8533-7ac380bf84f5"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.26+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:45.881+09', 'ready', NULL, '2026-09-30 16:10:28.261151+09', '2026-09-30 16:10:28.370515+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('d6871336-2ab3-4100-81c0-1418236588ac', 'tenant-a', NULL, '7c50d0b1-82ce-4d1b-a658-b174282aa4e1', 'v1', 'tenant-a の記憶 3 東京 会議 プロジェクト3 ZERO', 'd6d0bf800f00f3c35af37625f3533767a4db7afbdc77fe18c3bc2d5987ba70c1', 'tenant-a の記憶 3 東京 会議 プロジェクト3 ZERO', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.264Z", "kind": "stated", "speaker": "user", "sourceObservationId": "7c50d0b1-82ce-4d1b-a658-b174282aa4e1"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.266+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:45.887+09', 'ready', NULL, '2026-09-30 16:10:28.266486+09', '2026-09-30 16:10:28.372867+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('9f6e751a-d10d-4867-894c-3b3318fc5ad6', 'tenant-a', NULL, 'a46b840f-5880-4307-8d8c-6deda5af7cde', 'v1', 'tenant-a の記憶 5 東京 会議 プロジェクト0', 'edf34c29245092db70ab98057250239de4f569a113efa424ebda0f9cd882bd55', 'tenant-a の記憶 5 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.274Z", "kind": "stated", "speaker": "user", "sourceObservationId": "a46b840f-5880-4307-8d8c-6deda5af7cde"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.276+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:45.897+09', 'ready', NULL, '2026-09-30 16:10:28.276724+09', '2026-09-30 16:10:28.380177+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('6c000d76-3068-4f9a-b7f2-bf49c407604c', 'tenant-a', NULL, '537fcfb1-864a-4d2d-a3a4-1bccc4cae503', 'v1', 'tenant-a の記憶 7 東京 会議 プロジェクト2', '0c60f6ec18ba3a28b875b6830e0201a28a0ce0a0831c5c1cfa14d9213f4fccc3', 'tenant-a の記憶 7 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.286Z", "kind": "stated", "speaker": "user", "sourceObservationId": "537fcfb1-864a-4d2d-a3a4-1bccc4cae503"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.288+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:45.909+09', 'ready', NULL, '2026-09-30 16:10:28.288591+09', '2026-09-30 16:10:28.385235+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('f3153b73-6258-450f-ae4a-19807dbacb14', 'tenant-a', NULL, 'c3c2bdc0-9096-4579-b816-eba93a376bc1', 'v1', 'tenant-a の記憶 12 東京 会議 プロジェクト2', '1416843979dca4b10e813c98b42e4e64184da19a8246431ca987465bf0319a69', 'tenant-a の記憶 12 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.308Z", "kind": "stated", "speaker": "user", "sourceObservationId": "c3c2bdc0-9096-4579-b816-eba93a376bc1"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.31+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:45.931+09', 'ready', NULL, '2026-09-30 16:10:28.310527+09', '2026-09-30 16:10:28.396448+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('0142288a-451a-4d56-99e8-31edb1a7d52a', 'tenant-a', NULL, 'd50c9727-c674-4dcc-8c4b-0f2b7a52a38d', 'v1', 'tenant-a の記憶 13 東京 会議 プロジェクト3', '85fa57655dee036fb504dc9e026f2dfe383c1140f5fab5d93ff65f97a76f63c1', 'tenant-a の記憶 13 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.312Z", "kind": "stated", "speaker": "user", "sourceObservationId": "d50c9727-c674-4dcc-8c4b-0f2b7a52a38d"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.314+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:45.935+09', 'ready', NULL, '2026-09-30 16:10:28.314316+09', '2026-09-30 16:10:28.398618+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('7a65904e-aa1f-4438-9fa2-702c1d6fb953', 'tenant-a', NULL, '5c62a7cc-5ea8-4fe3-a984-d6a92e289dc3', 'v1', 'tenant-a の記憶 14 東京 会議 プロジェクト4', '566c00e514039c3cbdde42ca12af98244b4fc1d1fba5c31799c41667ccb84955', 'tenant-a の記憶 14 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.316Z", "kind": "stated", "speaker": "user", "sourceObservationId": "5c62a7cc-5ea8-4fe3-a984-d6a92e289dc3"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.317+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:45.938+09', 'ready', NULL, '2026-09-30 16:10:28.318056+09', '2026-09-30 16:10:28.400745+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('75e7ec0d-7c97-455d-828a-7be812c96d5a', 'tenant-a', NULL, '0f9124f0-75e0-4f90-a837-964a8a73e741', 'v1', 'tenant-a の記憶 15 東京 会議 プロジェクト0', 'f0b29bf3fc257d56d53bf3a40509a30894afa7846eb7397ab547ea18a3a29c38', 'tenant-a の記憶 15 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.320Z", "kind": "stated", "speaker": "user", "sourceObservationId": "0f9124f0-75e0-4f90-a837-964a8a73e741"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.321+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:45.942+09', 'ready', NULL, '2026-09-30 16:10:28.321614+09', '2026-09-30 16:10:28.402927+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('bdf590b6-cdf8-4f7f-9747-f274d8e039de', 'tenant-a', NULL, 'e5f562cf-fe5b-491e-8cbc-6a6c6c3d208c', 'v1', 'tenant-a の記憶 4 東京 会議 プロジェクト4', '2d4011873ef8b25d39bde2a8122f185e9e032a938e8e1020e527a073b0930df3', 'tenant-a の記憶 4 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.269Z", "kind": "stated", "speaker": "user", "sourceObservationId": "e5f562cf-fe5b-491e-8cbc-6a6c6c3d208c"}', 'superseded', '9f6e751a-d10d-4867-894c-3b3318fc5ad6', NULL, '{}', NULL, '2026-09-30 16:10:28.27+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:45.891+09', 'ready', NULL, '2026-09-30 16:10:28.271229+09', '2026-09-30 16:10:28.446959+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('71959e35-ff92-4e32-a488-24ac50e52e23', 'tenant-a', NULL, '8756c4a3-1be5-4269-9a40-8e7954d47b0c', 'v1', 'tenant-a の記憶 6 東京 会議 プロジェクト1', 'd930b5a8cf81e3b3b32791e8dae3c05994da72ef1265c035dfaf39080ed62dbe', 'tenant-a の記憶 6 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.279Z", "kind": "stated", "speaker": "user", "sourceObservationId": "8756c4a3-1be5-4269-9a40-8e7954d47b0c"}', 'contested', NULL, 'db52e2d3-3a70-4031-b38b-99a212ee5ce5', '{}', NULL, '2026-09-30 16:10:28.283+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:45.904+09', 'ready', NULL, '2026-09-30 16:10:28.283472+09', '2026-09-30 16:10:28.448797+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('b7a747ef-2733-4e8e-8e98-b8daaf0d1c49', 'tenant-a', NULL, '1c44e415-8ff0-4944-9021-367f57dc6ded', 'v1', 'tenant-a の記憶 9 東京 会議 プロジェクト4', '4c241e9f2abb28b016af405d09bb673284fc201c4fac4a039faba6f8c7e22fc3', 'tenant-a の記憶 9 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.296Z", "kind": "stated", "speaker": "user", "sourceObservationId": "1c44e415-8ff0-4944-9021-367f57dc6ded"}', 'archived', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.297+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:45.918+09', 'ready', NULL, '2026-09-30 16:10:28.298089+09', '2026-09-30 16:10:28.451656+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('0254ee12-a693-40d1-97ab-6d11e591459a', 'tenant-a', NULL, 'c18fb4a4-06af-4366-b8fe-f8bad0522dcc', 'v1', 'tenant-a の記憶 10 東京 会議 プロジェクト0 ZERO', 'f43c8e3670dc49dcd5e7d3d4067e6675ad27bf370e403c97f646b08db859894f', 'tenant-a の記憶 10 東京 会議 プロジェクト0 ZERO', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.300Z", "kind": "stated", "speaker": "user", "sourceObservationId": "c18fb4a4-06af-4366-b8fe-f8bad0522dcc"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.302+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:45.923+09', 'ready', NULL, '2026-09-30 16:10:28.302354+09', '2026-09-30 16:10:28.452904+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('b5bbe07f-7133-4192-ad0a-b7ce2d75dd27', 'tenant-a', NULL, 'ec2abc0b-10d4-4578-a585-71d85c50227f', 'v1', '[purged]', '8baacaa745d740261839f6dbe908954009bba75aead9ea0901933a52379e09f4', '[purged]', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.305Z", "kind": "stated", "speaker": "user", "sourceObservationId": "ec2abc0b-10d4-4578-a585-71d85c50227f"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.306+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:45.927+09', 'ready', '2026-09-30 16:10:28.456145+09', '2026-09-30 16:10:28.306664+09', '2026-09-30 16:10:28.456145+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('e9b4837a-7259-4c1f-ac42-623c40b65da8', 'tenant-a', NULL, '3170047c-439d-437b-80dd-f37d57c1609b', 'v1', 'tenant-a の記憶 0 東京 会議 プロジェクト0', 'd3ea19d3736314cb9c467c1662164327f232b7f4614ea76f675772f69c277594', 'tenant-a の記憶 0 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.235Z", "kind": "stated", "speaker": "user", "sourceObservationId": "3170047c-439d-437b-80dd-f37d57c1609b"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.243+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:45.864+09', 'ready', NULL, '2026-09-30 16:10:28.244488+09', '2026-09-30 16:10:28.365193+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('2ad5f6f4-6af3-480a-963d-c2581e800298', 'tenant-a', NULL, '8fa787c0-15d5-45cd-a8ef-82614da0e289', 'v1', 'tenant-a の記憶 16 東京 会議 プロジェクト1', 'ca52ff79646f23e88b31f2cd9bab84db866daa8ee904c6ffc4f2608348e05082', 'tenant-a の記憶 16 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.324Z", "kind": "stated", "speaker": "user", "sourceObservationId": "8fa787c0-15d5-45cd-a8ef-82614da0e289"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.326+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:45.947+09', 'ready', NULL, '2026-09-30 16:10:28.327162+09', '2026-09-30 16:10:28.405307+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('7f850fd5-b588-4e98-810e-61880d17f5dc', 'tenant-a', NULL, '664ba403-7c58-4a1c-baf6-0a57e1743de5', 'v1', 'tenant-a の記憶 17 東京 会議 プロジェクト2 ZERO', 'b143762528afffbb72a33fb24f70ebd4d19cd0cc89719dd7231a45971896fde7', 'tenant-a の記憶 17 東京 会議 プロジェクト2 ZERO', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.329Z", "kind": "stated", "speaker": "user", "sourceObservationId": "664ba403-7c58-4a1c-baf6-0a57e1743de5"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.33+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:45.951+09', 'ready', NULL, '2026-09-30 16:10:28.331004+09', '2026-09-30 16:10:28.408404+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('52352eb6-6c20-449b-bde9-92ceefad2119', 'tenant-a', NULL, 'de056da7-0494-49d4-a6af-df0bb6457a04', 'v1', 'tenant-a の記憶 18 東京 会議 プロジェクト3', '6d3a158a624537a869f95ca05e650119d80bbe0cd4f796b22bc3c31ea83ada8a', 'tenant-a の記憶 18 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.333Z", "kind": "stated", "speaker": "user", "sourceObservationId": "de056da7-0494-49d4-a6af-df0bb6457a04"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.334+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:45.955+09', 'ready', NULL, '2026-09-30 16:10:28.334534+09', '2026-09-30 16:10:28.411237+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('790d7bb0-7be7-410d-a875-69d94b4bd0ff', 'tenant-a', NULL, '2a678390-3e9f-4a00-ad81-d9b9f96da5e4', 'v1', 'tenant-a の記憶 19 東京 会議 プロジェクト4', '83b96ac18e746f06f8c77902fd8d7e7f3c59541caaa6ae2658298580ec04e043', 'tenant-a の記憶 19 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.339Z", "kind": "stated", "speaker": "user", "sourceObservationId": "2a678390-3e9f-4a00-ad81-d9b9f96da5e4"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.34+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:45.961+09', 'ready', NULL, '2026-09-30 16:10:28.341188+09', '2026-09-30 16:10:28.413893+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('5a7107e4-b415-4912-a260-b5ba85543982', 'tenant-a', NULL, '2533acb4-2f6e-476b-a555-e5cb3006169b', 'v1', 'tenant-a の記憶 21 東京 会議 プロジェクト1', '4c3e66f819f467c96c28794801e751d2d4f6a9e3cd240dcfc9c3bf55c1cacc57', 'tenant-a の記憶 21 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.347Z", "kind": "stated", "speaker": "user", "sourceObservationId": "2533acb4-2f6e-476b-a555-e5cb3006169b"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.348+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:45.969+09', 'ready', NULL, '2026-09-30 16:10:28.348712+09', '2026-09-30 16:10:28.419163+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('decede7e-0883-47c7-a8e3-0333baa2b19c', 'tenant-a', NULL, '8c3dffc1-e5ff-4131-8377-a8c800508a4d', 'v1', 'tenant-a の記憶 22 東京 会議 プロジェクト2', 'b72c9757075adda4486522b26365dfd82a6af69336a4c8f52d4771450c4ce0af', 'tenant-a の記憶 22 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.350Z", "kind": "stated", "speaker": "user", "sourceObservationId": "8c3dffc1-e5ff-4131-8377-a8c800508a4d"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.351+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:45.972+09', 'ready', NULL, '2026-09-30 16:10:28.352177+09', '2026-09-30 16:10:28.422057+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('8f147a2c-4cb8-4320-a1b6-db425fdad60b', 'tenant-a', NULL, 'aef701a6-ee0b-4360-89bf-a2221fac242f', 'v1', 'tenant-a の記憶 23 東京 会議 プロジェクト3', '26d0049fe3cf7614c786a48dd795226413a4f6260e020ea8356d457c6ff1ca3f', 'tenant-a の記憶 23 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.354Z", "kind": "stated", "speaker": "user", "sourceObservationId": "aef701a6-ee0b-4360-89bf-a2221fac242f"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.355+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:45.976+09', 'ready', NULL, '2026-09-30 16:10:28.355644+09', '2026-09-30 16:10:28.424303+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('8688815a-d446-472b-beed-78717974d078', 'tenant-a', NULL, '9576c6dd-dd9f-48d1-8d99-a19d430e838f', 'v1', 'tenant-a FAIL 埋め込み失敗 東京', 'ab1702dac85d2545c823794fc8106c348a2783463f2ac321911b7721adc9a696', 'tenant-a FAIL 埋め込み失敗 東京', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.357Z", "kind": "stated", "speaker": "user", "sourceObservationId": "9576c6dd-dd9f-48d1-8d99-a19d430e838f"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.358+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:45.979+09', 'failed', NULL, '2026-09-30 16:10:28.358837+09', '2026-09-30 16:10:28.425995+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('fd3d3f38-8d19-4f69-bc0c-bde37829b600', 'tenant-a', NULL, 'e7630a70-a4a2-496e-ad49-2fbe7fa6422f', 'v1', 'tenant-a 未埋め込み 0', '756d0ee3ef05fe980db2aa5224ed49ab257c9c10a80d33a77df32294e4a9b497', 'tenant-a 未埋め込み 0', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.427Z", "kind": "stated", "speaker": "user", "sourceObservationId": "e7630a70-a4a2-496e-ad49-2fbe7fa6422f"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.429+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.05+09', 'pending', NULL, '2026-09-30 16:10:28.429568+09', '2026-09-30 16:10:28.429568+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('19e371cd-0bc5-4a2e-bdd3-926c3e06a039', 'tenant-a', NULL, '3892bb50-d13f-49a3-9f5b-9bccc4ec8aab', 'v1', 'tenant-a 未埋め込み 1', '7a1a046d3656ac2ae59f0f95d457c9c60be31eb915f2dd5cdc53822faaefdf48', 'tenant-a 未埋め込み 1', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.431Z", "kind": "stated", "speaker": "user", "sourceObservationId": "3892bb50-d13f-49a3-9f5b-9bccc4ec8aab"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.433+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.054+09', 'pending', NULL, '2026-09-30 16:10:28.433679+09', '2026-09-30 16:10:28.433679+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('a473bc10-58af-4d43-a483-98ae7237f4cd', 'tenant-a', NULL, '9226deb4-9efe-4dd5-b839-41b0e73223e8', 'v1', 'tenant-a 未埋め込み 2', '899e3558b907c6a4074d675812af26d32f5a4d665344080e52cfed3d3c1218f6', 'tenant-a 未埋め込み 2', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.436Z", "kind": "stated", "speaker": "user", "sourceObservationId": "9226deb4-9efe-4dd5-b839-41b0e73223e8"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.441+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.062+09', 'skipped', NULL, '2026-09-30 16:10:28.441888+09', '2026-09-30 16:10:28.445596+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('db52e2d3-3a70-4031-b38b-99a212ee5ce5', 'tenant-a', NULL, 'ac48f49d-1570-40ff-a858-fd995fbbafa5', 'v1', 'tenant-a の記憶 8 東京 会議 プロジェクト3', 'b80d062281da38b404565ed86841de51799a3a0b5a8332e8ae6c080d35716009', 'tenant-a の記憶 8 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.292Z", "kind": "stated", "speaker": "user", "sourceObservationId": "ac48f49d-1570-40ff-a858-fd995fbbafa5"}', 'contested', NULL, '71959e35-ff92-4e32-a488-24ac50e52e23', '{}', NULL, '2026-09-30 16:10:28.293+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:45.914+09', 'ready', NULL, '2026-09-30 16:10:28.293956+09', '2026-09-30 16:10:28.448797+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('d21a2085-0e80-481f-8a1a-47d62e379080', 'tenant-a', NULL, '85a364b0-30e9-4351-a444-0c65189167bc', 'v1', 'tenant-a の記憶 20 東京 会議 プロジェクト0', '30b8312facf5b4d080051518335646cf1b0811d3dd74936bb276b5f511c2fda4', 'tenant-a の記憶 20 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.343Z", "kind": "stated", "speaker": "user", "sourceObservationId": "85a364b0-30e9-4351-a444-0c65189167bc"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.344+09', '2026-09-30 16:10:28.475+09', NULL, NULL, 1, 720, '2027-02-07 07:57:46.096+09', 'ready', NULL, '2026-09-30 16:10:28.345176+09', '2026-09-30 16:10:28.476155+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('98523396-eb33-468d-adbe-fd392d2bbb55', 'tenant-b', NULL, '798a8f2c-2e86-42f3-97e1-40d12069a4ab', 'v1', 'tenant-b の記憶 1 東京 会議 プロジェクト1', 'b95da75a3bc21f8d9d823c4d001c8086e008dcc6b38e31d6ed7199e9b758b564', 'tenant-b の記憶 1 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.481Z", "kind": "stated", "speaker": "user", "sourceObservationId": "798a8f2c-2e86-42f3-97e1-40d12069a4ab"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.482+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.103+09', 'ready', NULL, '2026-09-30 16:10:28.483317+09', '2026-09-30 16:10:28.555971+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('9d84c4ff-7580-46dd-a1f4-25701838f3a3', 'tenant-b', NULL, 'fcae1158-de44-475b-bbe4-2ad40dad448a', 'v1', 'tenant-b の記憶 2 東京 会議 プロジェクト2', 'fef0437ad217559ad5fb73795ca3cec2b335060d36ad7ba7a9da30c623a8f0d3', 'tenant-b の記憶 2 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.485Z", "kind": "stated", "speaker": "user", "sourceObservationId": "fcae1158-de44-475b-bbe4-2ad40dad448a"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.486+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.107+09', 'ready', NULL, '2026-09-30 16:10:28.487209+09', '2026-09-30 16:10:28.558138+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('a7b25522-dfdd-472c-b6d7-94186b139d05', 'tenant-b', NULL, '33eb90de-ce69-42c0-860c-27f0c484da6f', 'v1', 'tenant-b の記憶 5 東京 会議 プロジェクト0', '1d9b410d61390a28c636568bbffd238b4e1012db936d587ca2fb4c25642981e9', 'tenant-b の記憶 5 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.497Z", "kind": "stated", "speaker": "user", "sourceObservationId": "33eb90de-ce69-42c0-860c-27f0c484da6f"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.498+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.119+09', 'ready', NULL, '2026-09-30 16:10:28.499026+09', '2026-09-30 16:10:28.563788+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('af28ef0f-9e57-4941-a5d7-100fb2d99d1c', 'tenant-b', NULL, '3b8f0f8b-1255-4153-a26e-79ab9314be25', 'v1', 'tenant-b の記憶 7 東京 会議 プロジェクト2', 'f1d4ed789aa4b33b86f74868c1d9f1efbac874dbb3cbbdd89a13eabcd6826704', 'tenant-b の記憶 7 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.505Z", "kind": "stated", "speaker": "user", "sourceObservationId": "3b8f0f8b-1255-4153-a26e-79ab9314be25"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.506+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.127+09', 'ready', NULL, '2026-09-30 16:10:28.506502+09', '2026-09-30 16:10:28.567271+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('8827e601-7f09-43cf-beb7-51fb0a6ca239', 'tenant-b', NULL, 'af48aad9-78f1-4698-8d50-51e6acb5d770', 'v1', 'tenant-b の記憶 12 東京 会議 プロジェクト2', '7b361a170b64a9b41f97d624b8bc1cb0f2c68950bfea639ccb5a23c4344575f8', 'tenant-b の記憶 12 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.525Z", "kind": "stated", "speaker": "user", "sourceObservationId": "af48aad9-78f1-4698-8d50-51e6acb5d770"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.526+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.147+09', 'ready', NULL, '2026-09-30 16:10:28.52717+09', '2026-09-30 16:10:28.578683+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('3805ce1a-03ae-4ee7-9ffb-3dbab94f05e1', 'tenant-b', NULL, '1d9b8833-240b-4111-a2ec-c2909189414e', 'v1', 'tenant-b の記憶 13 東京 会議 プロジェクト3', '0dc090582bdaf2135130a122f6f926027aa9346166b076aa7ce9d878071c18f3', 'tenant-b の記憶 13 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.529Z", "kind": "stated", "speaker": "user", "sourceObservationId": "1d9b8833-240b-4111-a2ec-c2909189414e"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.531+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.152+09', 'ready', NULL, '2026-09-30 16:10:28.531255+09', '2026-09-30 16:10:28.589201+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('0ad4b72a-6e8a-47f5-a17b-5a15e8480e25', 'tenant-b', NULL, '841735b6-59d7-47c6-a884-c255db80e9f9', 'v1', 'tenant-b の記憶 15 東京 会議 プロジェクト0', '159e45fbd8a5ffaff4ae601883d4d60fd353ceca26759a1642630065cef3b241', 'tenant-b の記憶 15 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.537Z", "kind": "stated", "speaker": "user", "sourceObservationId": "841735b6-59d7-47c6-a884-c255db80e9f9"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.538+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.159+09', 'ready', NULL, '2026-09-30 16:10:28.538725+09', '2026-09-30 16:10:28.593182+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('f2ab6369-c531-4f9f-89d1-93c0ec5b6967', 'tenant-b', NULL, '17885792-b3d3-46e3-9351-4081ac0990e4', 'v1', 'tenant-b の記憶 16 東京 会議 プロジェクト1', 'b8c54c018860dad1bd5d84c2883f7deef7dba67a41562560b7454f3565547826', 'tenant-b の記憶 16 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.540Z", "kind": "stated", "speaker": "user", "sourceObservationId": "17885792-b3d3-46e3-9351-4081ac0990e4"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.541+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.162+09', 'ready', NULL, '2026-09-30 16:10:28.542155+09', '2026-09-30 16:10:28.595169+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('b6b09149-9e0a-44ea-8d8e-5e398a2b28c2', 'tenant-b', NULL, 'd51c6fcb-ee2d-4ba9-8409-fb31ac5b49c4', 'v1', 'tenant-b の記憶 17 東京 会議 プロジェクト2 ZERO', '512794d1b4203897a59658ba1c10d0d4ff10f5d69627a6dffa186e0a86c02feb', 'tenant-b の記憶 17 東京 会議 プロジェクト2 ZERO', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.544Z", "kind": "stated", "speaker": "user", "sourceObservationId": "d51c6fcb-ee2d-4ba9-8409-fb31ac5b49c4"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.545+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.166+09', 'ready', NULL, '2026-09-30 16:10:28.545298+09', '2026-09-30 16:10:28.596993+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('464f2fd3-d8aa-4282-a8e2-81c77162e584', 'tenant-b', NULL, 'f43f47cf-cd0c-401a-aa17-f34da5870c58', 'v1', 'tenant-b FAIL 埋め込み失敗 東京', 'dca6507a3912ad169580cf2764c29ddf080a9cbf73c32d7ddf16429d985d35ef', 'tenant-b FAIL 埋め込み失敗 東京', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.547Z", "kind": "stated", "speaker": "user", "sourceObservationId": "f43f47cf-cd0c-401a-aa17-f34da5870c58"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.548+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.169+09', 'failed', NULL, '2026-09-30 16:10:28.549027+09', '2026-09-30 16:10:28.598669+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('940d5ae2-af46-4c68-8032-e2913994003f', 'tenant-b', NULL, '026eb916-b6c1-4e5a-be18-172f4bc6730a', 'v1', 'tenant-b の記憶 4 東京 会議 プロジェクト4', '5940641d2d369c2cc336a4e7e0dfe324af8bd43c6c6bb540111ea25536b9f590', 'tenant-b の記憶 4 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.493Z", "kind": "stated", "speaker": "user", "sourceObservationId": "026eb916-b6c1-4e5a-be18-172f4bc6730a"}', 'superseded', 'a7b25522-dfdd-472c-b6d7-94186b139d05', NULL, '{}', NULL, '2026-09-30 16:10:28.494+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.115+09', 'ready', NULL, '2026-09-30 16:10:28.495034+09', '2026-09-30 16:10:28.613254+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('30d58bb2-fc98-4a76-ad29-9ce67eaab64c', 'tenant-b', NULL, '69100d7a-9aed-4d47-a4ec-2b62dab54515', 'v1', 'tenant-b の記憶 6 東京 会議 プロジェクト1', '25dbc01aa826c3caa1c214b61d630f769615fc5a4f74f62be2b71c2a659e3fa8', 'tenant-b の記憶 6 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.501Z", "kind": "stated", "speaker": "user", "sourceObservationId": "69100d7a-9aed-4d47-a4ec-2b62dab54515"}', 'contested', NULL, '7b425243-9d71-4795-9cff-6ed41ca62635', '{}', NULL, '2026-09-30 16:10:28.502+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.123+09', 'ready', NULL, '2026-09-30 16:10:28.502902+09', '2026-09-30 16:10:28.614457+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('d9097e76-d0e1-4463-b9c3-32da098ab361', 'tenant-b', NULL, 'c1a4bde9-7e9c-41ea-a82f-4aec9a396fe8', 'v1', 'tenant-b の記憶 9 東京 会議 プロジェクト4', '1e67543f28e3ecb46017a56947f528295cfd849f37bbff911216c8f13f03cb45', 'tenant-b の記憶 9 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.512Z", "kind": "stated", "speaker": "user", "sourceObservationId": "c1a4bde9-7e9c-41ea-a82f-4aec9a396fe8"}', 'archived', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.513+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.134+09', 'ready', NULL, '2026-09-30 16:10:28.513748+09', '2026-09-30 16:10:28.616858+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('1c0582e1-781b-43de-875c-39424f4a606c', 'tenant-b', NULL, '17fcbc7c-d5a2-4720-beed-f0f30c710c55', 'v1', 'tenant-b の記憶 10 東京 会議 プロジェクト0 ZERO', 'e3ce75d1b42cf68db24819b6cf5a26b4168b236f492bda9ec4f44f99baf6e59f', 'tenant-b の記憶 10 東京 会議 プロジェクト0 ZERO', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.516Z", "kind": "stated", "speaker": "user", "sourceObservationId": "17fcbc7c-d5a2-4720-beed-f0f30c710c55"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.517+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.138+09', 'ready', NULL, '2026-09-30 16:10:28.517874+09', '2026-09-30 16:10:28.618155+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('34e46d3e-27d1-49bd-ac5e-00b8303fbb1c', 'tenant-b', NULL, '1177f4a6-6f2f-46b8-bf1b-5f0753770719', 'v1', '[purged]', '624794e8e55d99b8d71021f048790ff041d1bfb438372d59bcdfa91e5e3b0bcd', '[purged]', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.521Z", "kind": "stated", "speaker": "user", "sourceObservationId": "1177f4a6-6f2f-46b8-bf1b-5f0753770719"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.522+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.143+09', 'ready', '2026-09-30 16:10:28.620627+09', '2026-09-30 16:10:28.522683+09', '2026-09-30 16:10:28.620627+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('e063c891-63b5-427c-9678-484e0cfec148', 'tenant-b', NULL, '70350c04-99e7-44c6-993c-dc5f8fc83b40', 'v1', 'tenant-b の記憶 14 東京 会議 プロジェクト4', '8a607cfc5964eaf69142f32afe35b75600e27d38176864ada321967ce349bc64', 'tenant-b の記憶 14 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.533Z", "kind": "stated", "speaker": "user", "sourceObservationId": "70350c04-99e7-44c6-993c-dc5f8fc83b40"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.535+09', '2026-09-30 16:10:28.627+09', NULL, NULL, 1, 720, '2027-02-07 07:57:46.248+09', 'ready', NULL, '2026-09-30 16:10:28.535522+09', '2026-09-30 16:10:28.628484+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('602d957e-cff9-425f-b386-8565c7af9783', 'tenant-b', NULL, '52476b9e-6649-4fb3-a330-3a955c0a4ae3', 'v1', 'tenant-b の記憶 0 東京 会議 プロジェクト0', '081a9a9f113b084d0ccebeb4e29f753910bca11b2e4e20168eca50413e85a174', 'tenant-b の記憶 0 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.477Z", "kind": "stated", "speaker": "user", "sourceObservationId": "52476b9e-6649-4fb3-a330-3a955c0a4ae3"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.478+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.099+09', 'ready', NULL, '2026-09-30 16:10:28.479322+09', '2026-09-30 16:10:28.554084+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('a8bdd009-902e-4d8e-aa86-46533de82784', 'tenant-b', NULL, '8632e4e1-89ec-4179-812f-afe323083eea', 'v1', 'tenant-b の記憶 3 東京 会議 プロジェクト3 ZERO', '4e273dcb447fab0d9f4acfd5e8288bf45f0c7eb77b08b9cc0534c25d49c0c4f8', 'tenant-b の記憶 3 東京 会議 プロジェクト3 ZERO', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.489Z", "kind": "stated", "speaker": "user", "sourceObservationId": "8632e4e1-89ec-4179-812f-afe323083eea"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.49+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.111+09', 'ready', NULL, '2026-09-30 16:10:28.490856+09', '2026-09-30 16:10:28.560041+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('6b031499-48ac-43ea-809f-9e706588e681', 'tenant-b', NULL, '21dc8ea7-d9db-45ea-b661-8c717990146d', 'v1', 'tenant-b 未埋め込み 0', '4f033a8ab5dff18cce4bfac1ffa04151f80b45e51806b9cebeca92a143ae6386', 'tenant-b 未埋め込み 0', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.600Z", "kind": "stated", "speaker": "user", "sourceObservationId": "21dc8ea7-d9db-45ea-b661-8c717990146d"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.601+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.222+09', 'pending', NULL, '2026-09-30 16:10:28.601711+09', '2026-09-30 16:10:28.601711+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('f4732ff5-ac81-4824-8b4c-b4fab0e0ccec', 'tenant-b', NULL, '31592c08-72fb-4b86-ba57-3277ebb273e4', 'v1', 'tenant-b 未埋め込み 1', '9d77f4b53475fe24e31aaa3bcdc02aa1a0786c37888dcee783f146c4aae191e2', 'tenant-b 未埋め込み 1', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.603Z", "kind": "stated", "speaker": "user", "sourceObservationId": "31592c08-72fb-4b86-ba57-3277ebb273e4"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.605+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.226+09', 'pending', NULL, '2026-09-30 16:10:28.606607+09', '2026-09-30 16:10:28.606607+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('3d8b7a59-9446-4c53-9ae9-c289e288ca6f', 'tenant-b', NULL, '47928993-378d-4d18-a28a-d594a9e8a19e', 'v1', 'tenant-b 未埋め込み 2', '318fb30d6dda58f1c972e4779c59979fbd926637878da937d6155ac62a286d02', 'tenant-b 未埋め込み 2', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.608Z", "kind": "stated", "speaker": "user", "sourceObservationId": "47928993-378d-4d18-a28a-d594a9e8a19e"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.609+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.23+09', 'skipped', NULL, '2026-09-30 16:10:28.610106+09', '2026-09-30 16:10:28.612201+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('7b425243-9d71-4795-9cff-6ed41ca62635', 'tenant-b', NULL, '3c85995e-851b-40b3-8cc6-b9a03bd79856', 'v1', 'tenant-b の記憶 8 東京 会議 プロジェクト3', '03f24fe74d5d2e3d56878e412d3b0daf983f57c46d18f1bf25917b76cf7ef9f6', 'tenant-b の記憶 8 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.508Z", "kind": "stated", "speaker": "user", "sourceObservationId": "3c85995e-851b-40b3-8cc6-b9a03bd79856"}', 'forgotten', NULL, '30d58bb2-fc98-4a76-ad29-9ce67eaab64c', '{}', NULL, '2026-09-30 16:10:28.509+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.13+09', 'ready', NULL, '2026-09-30 16:10:28.510179+09', '2026-09-30 16:10:28.622269+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('bcd20266-65d9-4d90-b8fe-4eee19f5d0b7', 'tenant-c', NULL, '5d5df62e-7088-47c7-b444-425dce000eda', 'v1', 'tenant-c の記憶 1 東京 会議 プロジェクト1', 'f97a8b4d6e8a9c4b9cc08f892895a26c5150d4dc14b0da37a299e97b759312b2', 'tenant-c の記憶 1 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.632Z", "kind": "stated", "speaker": "user", "sourceObservationId": "5d5df62e-7088-47c7-b444-425dce000eda"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.633+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.254+09', 'ready', NULL, '2026-09-30 16:10:28.634076+09', '2026-09-30 16:10:28.670321+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('e7dc9134-bf43-46b6-ad48-1530fadfddff', 'tenant-c', NULL, 'a7bf69ac-0b74-4a20-9480-4045f3eb604e', 'v1', 'tenant-c の記憶 3 東京 会議 プロジェクト3 ZERO', '94612eb1b4f64fa932a1d3db6feb48231cb950d9ffd00939776db4cf1eb29c26', 'tenant-c の記憶 3 東京 会議 プロジェクト3 ZERO', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.640Z", "kind": "stated", "speaker": "user", "sourceObservationId": "a7bf69ac-0b74-4a20-9480-4045f3eb604e"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.64+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.261+09', 'ready', NULL, '2026-09-30 16:10:28.641069+09', '2026-09-30 16:10:28.673685+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('a5d1f82f-80cd-4f39-8067-47e16e0e8f6f', 'tenant-c', NULL, '5261947b-df7f-4e75-b8d6-8a70cf1ddeb7', 'v1', 'tenant-c の記憶 7 東京 会議 プロジェクト2', '8c524a04f68127aef3b7b341e63ac27629ee3136f0ef9da63934e27c206cb419', 'tenant-c の記憶 7 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.651Z", "kind": "stated", "speaker": "user", "sourceObservationId": "5261947b-df7f-4e75-b8d6-8a70cf1ddeb7"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.652+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.273+09', 'ready', NULL, '2026-09-30 16:10:28.652527+09', '2026-09-30 16:10:28.680572+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('957b1f8d-0583-4845-91c4-c1dc47b5e4b1', 'tenant-c', NULL, '174d4196-adcf-4868-bdd6-586ba61c3689', 'v1', 'tenant-c の記憶 4 東京 会議 プロジェクト4', '81f4ee70cb39ef24184d9447f8e119462e2b333831286169f12207dd00f50327', 'tenant-c の記憶 4 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.642Z", "kind": "stated", "speaker": "user", "sourceObservationId": "174d4196-adcf-4868-bdd6-586ba61c3689"}', 'superseded', '9a51add5-7e2b-401b-abcd-1c425efaab64', NULL, '{}', NULL, '2026-09-30 16:10:28.643+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.264+09', 'ready', NULL, '2026-09-30 16:10:28.643732+09', '2026-09-30 16:10:28.701457+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('6aa8e0ff-f2b5-40ed-9c6e-abefb74a8ef7', 'tenant-c', NULL, 'cd9f3f9f-9d3f-474b-a5b8-1eceb426b359', 'v1', 'tenant-c の記憶 9 東京 会議 プロジェクト4', 'd8961ae07e5a93b6b0dc84ea6ee4aa46d7a585e6dfcbda5aaddc38a2ce3974b6', 'tenant-c の記憶 9 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.656Z", "kind": "stated", "speaker": "user", "sourceObservationId": "cd9f3f9f-9d3f-474b-a5b8-1eceb426b359"}', 'archived', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.657+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.278+09', 'ready', NULL, '2026-09-30 16:10:28.657775+09', '2026-09-30 16:10:28.704237+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('04033cd4-9639-4081-aef9-c5f4edf9ec8b', 'tenant-c', NULL, 'b5f667ea-af53-4af9-bd22-e547e9bdafe8', 'v1', 'tenant-c の記憶 10 東京 会議 プロジェクト0 ZERO', 'be6295fd3fa665a4400e99e456e7ac4a6311b950abd5ab167494cf5cf1661dc4', 'tenant-c の記憶 10 東京 会議 プロジェクト0 ZERO', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.659Z", "kind": "stated", "speaker": "user", "sourceObservationId": "b5f667ea-af53-4af9-bd22-e547e9bdafe8"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.66+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.281+09', 'ready', NULL, '2026-09-30 16:10:28.660488+09', '2026-09-30 16:10:28.704994+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('9a51add5-7e2b-401b-abcd-1c425efaab64', 'tenant-c', NULL, '2308068d-6d20-4e72-bedb-82b33db53c40', 'v1', 'tenant-c の記憶 5 東京 会議 プロジェクト0', '0996fea87104119898e02a0d9962c82a2dfe8c52e32205dc818277bcf516daf6', 'tenant-c の記憶 5 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.645Z", "kind": "stated", "speaker": "user", "sourceObservationId": "2308068d-6d20-4e72-bedb-82b33db53c40"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.646+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.267+09', 'ready', NULL, '2026-09-30 16:10:28.646621+09', '2026-09-30 16:10:28.709074+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('86537f40-a1c3-4777-a868-66f1622eb652', 'tenant-c', NULL, '404a82bf-e9c1-44fc-8cd9-cbff2c2fd200', 'v1', 'tenant-c の記憶 2 東京 会議 プロジェクト2', '2576291adf7ad31335c6494eb95a197053599c859b1067bc5f6b08c63fbd8fc2', 'tenant-c の記憶 2 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.636Z", "kind": "stated", "speaker": "user", "sourceObservationId": "404a82bf-e9c1-44fc-8cd9-cbff2c2fd200"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.637+09', '2026-09-30 16:10:28.714+09', NULL, NULL, 1, 720, '2027-02-07 07:57:46.335+09', 'ready', NULL, '2026-09-30 16:10:28.637278+09', '2026-09-30 16:10:28.715186+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('67a19942-fd02-4e21-b29c-fe6c3235e52e', 'tenant-c', NULL, '897e33f9-7abb-4c13-ab9c-379816fc8531', 'v1', 'tenant-c の記憶 0 東京 会議 プロジェクト0', '0d78da8c6a4e2de262064e70959180f45578ab348746afc04814736d3ec98420', 'tenant-c の記憶 0 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.629Z", "kind": "stated", "speaker": "user", "sourceObservationId": "897e33f9-7abb-4c13-ab9c-379816fc8531"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.63+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.251+09', 'ready', NULL, '2026-09-30 16:10:28.63071+09', '2026-09-30 16:10:28.668614+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('6031bd81-b545-4b72-9737-2073ebdd0c42', 'tenant-c', NULL, '4b686057-0886-4b17-ba86-458597b54aef', 'v1', 'tenant-c FAIL 埋め込み失敗 東京', '985f97e69b2fc62b500ebd50803bce5a72393d80852f55d01d88a21002fd7746', 'tenant-c FAIL 埋め込み失敗 東京', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.664Z", "kind": "stated", "speaker": "user", "sourceObservationId": "4b686057-0886-4b17-ba86-458597b54aef"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.665+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.286+09', 'failed', NULL, '2026-09-30 16:10:28.665432+09', '2026-09-30 16:10:28.689186+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('9efcc2f7-6130-4276-9b83-e64b09deaac3', 'tenant-c', NULL, 'fe42f01d-6aa4-4482-92de-2e34fcd3b584', 'v1', 'tenant-c 未埋め込み 0', 'dbbed7a9da3bc87703ee74ec7fcbae128292a28245a094e1e7fe55b2e761766d', 'tenant-c 未埋め込み 0', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.690Z", "kind": "stated", "speaker": "user", "sourceObservationId": "fe42f01d-6aa4-4482-92de-2e34fcd3b584"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.692+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.313+09', 'pending', NULL, '2026-09-30 16:10:28.692684+09', '2026-09-30 16:10:28.692684+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('f6e5b0de-b8fc-457a-b825-8887d9e63931', 'tenant-c', NULL, '482310e0-72f1-429a-8470-7391cd2b0cd8', 'v1', 'tenant-c 未埋め込み 1', '6fef40b085316dc1f9517118e7701e59fddc1231ce2b4b7b03aaf45936697d74', 'tenant-c 未埋め込み 1', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.694Z", "kind": "stated", "speaker": "user", "sourceObservationId": "482310e0-72f1-429a-8470-7391cd2b0cd8"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.695+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.316+09', 'pending', NULL, '2026-09-30 16:10:28.696044+09', '2026-09-30 16:10:28.696044+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('aeb1c34f-fe5c-43ab-bfde-3af9000488f7', 'tenant-c', NULL, 'cf6fa671-3757-444e-bb02-52e573c9817d', 'v1', 'tenant-c 未埋め込み 2', 'd4169a93c46303e6cc20af167d50c6ffb9c86896911949620cd36e561554b6c1', 'tenant-c 未埋め込み 2', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.697Z", "kind": "stated", "speaker": "user", "sourceObservationId": "cf6fa671-3757-444e-bb02-52e573c9817d"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.698+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.319+09', 'skipped', NULL, '2026-09-30 16:10:28.698939+09', '2026-09-30 16:10:28.70067+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('69eca64a-eb31-45e3-8ac8-d79a5590b8da', 'tenant-c', NULL, '40c3d240-b305-4175-b58f-0eaa6e7bfdd5', 'v1', 'tenant-c の記憶 6 東京 会議 プロジェクト1', '1349732c0ebd9031ddc9bcae41973c5c6b6ab2f76e2179b5374ad6957af1fe87', 'tenant-c の記憶 6 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.648Z", "kind": "stated", "speaker": "user", "sourceObservationId": "40c3d240-b305-4175-b58f-0eaa6e7bfdd5"}', 'contested', NULL, '91ce637e-a3a0-4936-909c-2c31d8d5b039', '{}', NULL, '2026-09-30 16:10:28.649+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.27+09', 'ready', NULL, '2026-09-30 16:10:28.649811+09', '2026-09-30 16:10:28.702417+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('91ce637e-a3a0-4936-909c-2c31d8d5b039', 'tenant-c', NULL, '3e624c0a-ba29-479a-bdd9-b8bbc21243a8', 'v1', 'tenant-c の記憶 8 東京 会議 プロジェクト3', '27955d03f0fb4db217579a1e5dbf74beed76d3f569305b1ab21cd24db6b92e36', 'tenant-c の記憶 8 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.654Z", "kind": "stated", "speaker": "user", "sourceObservationId": "3e624c0a-ba29-479a-bdd9-b8bbc21243a8"}', 'contested', NULL, '69eca64a-eb31-45e3-8ac8-d79a5590b8da', '{}', NULL, '2026-09-30 16:10:28.655+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.276+09', 'ready', NULL, '2026-09-30 16:10:28.655308+09', '2026-09-30 16:10:28.702417+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('a00cde4a-97e6-4621-b312-1ab2065791f1', 'tenant-c', NULL, '2aee3c82-20d1-468a-97bb-1939e439a832', 'v1', '[purged]', '90508b50cef379d5c03fa9f0c876b432c0e3fe77e30b0a0ccc82349c9d4a406f', '[purged]', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.662Z", "kind": "stated", "speaker": "user", "sourceObservationId": "2aee3c82-20d1-468a-97bb-1939e439a832"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.662+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.283+09', 'ready', '2026-09-30 16:10:28.707456+09', '2026-09-30 16:10:28.662922+09', '2026-09-30 16:10:28.707456+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('9e33ee7a-e83d-45c2-8d50-0e5fadc3e5db', 'tenant-a2', NULL, '69c45eab-23b5-4545-b619-1ed91221a75b', 'v1', 'tenant-a2 の記憶 1 東京 会議 プロジェクト1', '98db05eaf2b468995ca8ddfb04238b6a3f78950faff175f1bfb6be45a8249e43', 'tenant-a2 の記憶 1 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.718Z", "kind": "stated", "speaker": "user", "sourceObservationId": "69c45eab-23b5-4545-b619-1ed91221a75b"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.72+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.341+09', 'ready', NULL, '2026-09-30 16:10:28.720366+09', '2026-09-30 16:10:28.755541+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('5cd10797-6df6-49d8-8eb4-e901fc41cc7c', 'tenant-a2', NULL, '6551e295-d41c-4f47-add8-6b2d23df0308', 'v1', 'tenant-a2 の記憶 3 東京 会議 プロジェクト3 ZERO', 'a785d27623732af65fc0f05c80ea5e8638cd85eb944016167297bd92393c0331', 'tenant-a2 の記憶 3 東京 会議 プロジェクト3 ZERO', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.725Z", "kind": "stated", "speaker": "user", "sourceObservationId": "6551e295-d41c-4f47-add8-6b2d23df0308"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.726+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.347+09', 'ready', NULL, '2026-09-30 16:10:28.726789+09', '2026-09-30 16:10:28.758818+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('9125e691-5d32-4e89-bee6-2a2d96ca3235', 'tenant-a2', NULL, '0ccc9173-835d-4bdb-a545-91e437ba77e3', 'v1', 'tenant-a2 の記憶 5 東京 会議 プロジェクト0', '2ff9054147bebbf3ab7b87786763739a75177d4a5b1f441bea040bf1eca421f4', 'tenant-a2 の記憶 5 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.731Z", "kind": "stated", "speaker": "user", "sourceObservationId": "0ccc9173-835d-4bdb-a545-91e437ba77e3"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.732+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.353+09', 'ready', NULL, '2026-09-30 16:10:28.732715+09', '2026-09-30 16:10:28.762436+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('287a2f8e-9486-426b-8adf-c18e9f02f01e', 'tenant-a2', NULL, '1f53fa34-341b-4866-a248-7690e5a509f5', 'v1', 'tenant-a2 の記憶 7 東京 会議 プロジェクト2', '914fb28b9e9744124fe125428a1d2ccdd0770428843fc02994496676178c35ee', 'tenant-a2 の記憶 7 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.737Z", "kind": "stated", "speaker": "user", "sourceObservationId": "1f53fa34-341b-4866-a248-7690e5a509f5"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.738+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.359+09', 'ready', NULL, '2026-09-30 16:10:28.738759+09', '2026-09-30 16:10:28.76564+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('f8bdff5b-da7e-48aa-802f-f5ca4eb792be', 'tenant-a2', NULL, '57b3e37b-cb8a-49f7-bd53-7fbf8708af81', 'v1', 'tenant-a2 の記憶 4 東京 会議 プロジェクト4', '24ab90528718614c3e988124ed86cb1748700763560be7ef27c8bf4b5dcfd1ab', 'tenant-a2 の記憶 4 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.728Z", "kind": "stated", "speaker": "user", "sourceObservationId": "57b3e37b-cb8a-49f7-bd53-7fbf8708af81"}', 'superseded', '9125e691-5d32-4e89-bee6-2a2d96ca3235', NULL, '{}', NULL, '2026-09-30 16:10:28.729+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.35+09', 'ready', NULL, '2026-09-30 16:10:28.729894+09', '2026-09-30 16:10:28.802349+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('97981b11-aee7-45ea-a2eb-c24d3eae9ce2', 'tenant-a2', NULL, '8074c4a0-3534-41ff-99f7-f66ab0e918c0', 'v1', 'tenant-a2 の記憶 6 東京 会議 プロジェクト1', '7592207a458219fa91a20d15fb9715e0462c1b13647e460421449a8734cc3f3b', 'tenant-a2 の記憶 6 東京 会議 プロジェクト1', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.734Z", "kind": "stated", "speaker": "user", "sourceObservationId": "8074c4a0-3534-41ff-99f7-f66ab0e918c0"}', 'contested', NULL, '04080c4e-4828-478f-a4fc-9fce71877410', '{}', NULL, '2026-09-30 16:10:28.735+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.356+09', 'ready', NULL, '2026-09-30 16:10:28.73568+09', '2026-09-30 16:10:28.803261+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('4f45de75-e881-4856-8d05-aad412e744c3', 'tenant-a2', NULL, '41504b63-b402-4ae1-9e79-abcb9e801955', 'v1', 'tenant-a2 の記憶 2 東京 会議 プロジェクト2', '4cf1d599eeca369fd9803aad38e37386c99caf014b2df0588842e802cb851f62', 'tenant-a2 の記憶 2 東京 会議 プロジェクト2', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.722Z", "kind": "stated", "speaker": "user", "sourceObservationId": "41504b63-b402-4ae1-9e79-abcb9e801955"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.722+09', '2026-09-30 16:10:28.82+09', NULL, NULL, 1, 720, '2027-02-07 07:57:46.441+09', 'ready', NULL, '2026-09-30 16:10:28.723205+09', '2026-09-30 16:10:28.821565+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('5edcbe69-cc3f-4cd1-a611-a0bc6da517c6', 'tenant-a2', NULL, '00146ece-dfb1-4c18-b274-f804695477f6', 'v1', 'tenant-a2 の記憶 0 東京 会議 プロジェクト0', 'cc6965c4ce873014f25affb39c4d6773bd8fb57667bfa6de70490b30eeb8b9c2', 'tenant-a2 の記憶 0 東京 会議 プロジェクト0', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.715Z", "kind": "stated", "speaker": "user", "sourceObservationId": "00146ece-dfb1-4c18-b274-f804695477f6"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.716+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.337+09', 'ready', NULL, '2026-09-30 16:10:28.717101+09', '2026-09-30 16:10:28.753316+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('51bcf032-4265-47d1-be97-7315e758f0f2', 'tenant-a2', NULL, '8f97f8b5-12b3-410f-b143-6eb05e4905da', 'v1', 'tenant-a2 FAIL 埋め込み失敗 東京', '72456a5d7a68e3f7d1e7d082bd8429d137478336dc0b7ab44c25aae0508cf9c7', 'tenant-a2 FAIL 埋め込み失敗 東京', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.747Z", "kind": "stated", "speaker": "user", "sourceObservationId": "8f97f8b5-12b3-410f-b143-6eb05e4905da"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.749+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.37+09', 'failed', NULL, '2026-09-30 16:10:28.749612+09', '2026-09-30 16:10:28.7702+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('66a93937-8913-4661-9b63-85c4f0877869', 'tenant-a2', NULL, '143b2d68-cf0b-4510-9f37-64c91d0d6ee6', 'v1', 'tenant-a2 未埋め込み 2', '361bf58e0bbb5d4804764e21fd48bddde845290c4fcd3281b746852036325696', 'tenant-a2 未埋め込み 2', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.797Z", "kind": "stated", "speaker": "user", "sourceObservationId": "143b2d68-cf0b-4510-9f37-64c91d0d6ee6"}', 'active', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.799+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.42+09', 'skipped', NULL, '2026-09-30 16:10:28.799577+09', '2026-09-30 16:10:28.801569+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('04080c4e-4828-478f-a4fc-9fce71877410', 'tenant-a2', NULL, 'a560737a-6d4c-4753-852f-844bd132ae23', 'v1', 'tenant-a2 の記憶 8 東京 会議 プロジェクト3', '97de39f5fe1e8a6b2164b4726c2ae28bd112a4222632a171a6a79d866131fa79', 'tenant-a2 の記憶 8 東京 会議 プロジェクト3', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.740Z", "kind": "stated", "speaker": "user", "sourceObservationId": "a560737a-6d4c-4753-852f-844bd132ae23"}', 'contested', NULL, '97981b11-aee7-45ea-a2eb-c24d3eae9ce2', '{}', NULL, '2026-09-30 16:10:28.741+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.362+09', 'ready', NULL, '2026-09-30 16:10:28.742142+09', '2026-09-30 16:10:28.803261+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('09458b38-45e0-424f-b606-f422bca00e46', 'tenant-a2', NULL, '50516e9d-2dba-4bf8-be6c-8489bdd7f2e1', 'v1', 'tenant-a2 の記憶 9 東京 会議 プロジェクト4', 'f43da00aa2d66eb30de895210fc22e5cba0548b91eb41edc808208389480c46c', 'tenant-a2 の記憶 9 東京 会議 プロジェクト4', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.744Z", "kind": "stated", "speaker": "user", "sourceObservationId": "50516e9d-2dba-4bf8-be6c-8489bdd7f2e1"}', 'archived', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.745+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.366+09', 'ready', NULL, '2026-09-30 16:10:28.745415+09', '2026-09-30 16:10:28.806076+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('37ca332a-60df-40b4-add5-0b80cc38dd49', 'tenant-a2', NULL, 'a0534cb7-ee9a-4aac-aa48-af5da5eb4572', 'v1', 'tenant-a2 未埋め込み 0', '096af51a3f55ac6f12d4f7ae6b8dadd71299c722c9f56ac9764db3bd05d536e4', 'tenant-a2 未埋め込み 0', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.771Z", "kind": "stated", "speaker": "user", "sourceObservationId": "a0534cb7-ee9a-4aac-aa48-af5da5eb4572"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.772+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.393+09', 'pending', NULL, '2026-09-30 16:10:28.772437+09', '2026-09-30 16:10:28.807716+09', NULL, NULL, NULL);
INSERT INTO public.memories VALUES ('f193d97d-23d3-4df2-aa57-e305e2196534', 'tenant-a2', NULL, '122bfe15-0289-4e27-85cd-f18a8aeba1c2', 'v1', '[purged]', 'e78005a62ce1fe1dc602590187cd521751267c830e60191f8b6622dafb10a298', '[purged]', 'llm', 'stated', '{"at": "2026-09-30T07:10:28.774Z", "kind": "stated", "speaker": "user", "sourceObservationId": "122bfe15-0289-4e27-85cd-f18a8aeba1c2"}', 'forgotten', NULL, NULL, '{}', NULL, '2026-09-30 16:10:28.775+09', NULL, NULL, NULL, 1, 720, '2027-02-07 07:57:46.396+09', 'pending', '2026-09-30 16:10:28.810692+09', '2026-09-30 16:10:28.775388+09', '2026-09-30 16:10:28.810692+09', NULL, NULL, NULL);


--
-- Data for Name: memory_embeddings_some_very_long_provider_name_an_extr_b34ef257; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '67a19942-fd02-4e21-b29c-fe6c3235e52e', '[16,772,45,207]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-30 16:10:28.6679+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', 'bcd20266-65d9-4d90-b8fe-4eee19f5d0b7', '[16,773,45,208]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-30 16:10:28.66994+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '86537f40-a1c3-4777-a868-66f1622eb652', '[16,774,45,209]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-30 16:10:28.671631+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', 'e7dc9134-bf43-46b6-ad48-1530fadfddff', '[0,0,0,0]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-30 16:10:28.673275+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '957b1f8d-0583-4845-91c4-c1dc47b5e4b1', '[16,776,45,211]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-30 16:10:28.674818+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '9a51add5-7e2b-401b-abcd-1c425efaab64', '[16,777,45,207]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-30 16:10:28.676506+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '69eca64a-eb31-45e3-8ac8-d79a5590b8da', '[16,778,45,208]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-30 16:10:28.678371+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', 'a5d1f82f-80cd-4f39-8067-47e16e0e8f6f', '[16,779,45,209]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-30 16:10:28.680191+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '91ce637e-a3a0-4936-909c-2c31d8d5b039', '[16,780,45,210]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-30 16:10:28.681778+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '6aa8e0ff-f2b5-40ed-9c6e-abefb74a8ef7', '[16,781,45,211]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-30 16:10:28.683738+09');
INSERT INTO public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 VALUES ('tenant-c', '04033cd4-9639-4081-aef9-c5f4edf9ec8b', '[0,0,0,0]', 'an-extremely-long-embedding-model-name-v2-large', '2026-09-30 16:10:28.685298+09');


--
-- Data for Name: memory_embeddings_test_fixture_model_3; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'e9b4837a-7259-4c1f-ac42-623c40b65da8', '[677,880,478]', 'fixture-model', '2026-09-30 16:10:28.363783+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '385ddb84-f30d-45b6-a610-a90f4fa542da', '[678,881,478]', 'fixture-model', '2026-09-30 16:10:28.367468+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'cdaec7f7-e905-4944-bea0-efbd5313f206', '[679,882,478]', 'fixture-model', '2026-09-30 16:10:28.369977+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'd6871336-2ab3-4100-81c0-1418236588ac', '[0,0,0]', 'fixture-model', '2026-09-30 16:10:28.372268+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'bdf590b6-cdf8-4f7f-9747-f274d8e039de', '[681,884,478]', 'fixture-model', '2026-09-30 16:10:28.375071+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '9f6e751a-d10d-4867-894c-3b3318fc5ad6', '[677,885,478]', 'fixture-model', '2026-09-30 16:10:28.379565+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '71959e35-ff92-4e32-a488-24ac50e52e23', '[678,886,478]', 'fixture-model', '2026-09-30 16:10:28.382064+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '6c000d76-3068-4f9a-b7f2-bf49c407604c', '[679,887,478]', 'fixture-model', '2026-09-30 16:10:28.384652+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'db52e2d3-3a70-4031-b38b-99a212ee5ce5', '[680,888,478]', 'fixture-model', '2026-09-30 16:10:28.387002+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'b7a747ef-2733-4e8e-8e98-b8daaf0d1c49', '[681,889,478]', 'fixture-model', '2026-09-30 16:10:28.389389+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '0254ee12-a693-40d1-97ab-6d11e591459a', '[0,0,0]', 'fixture-model', '2026-09-30 16:10:28.391421+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'f3153b73-6258-450f-ae4a-19807dbacb14', '[855,769,464]', 'fixture-model', '2026-09-30 16:10:28.39599+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '0142288a-451a-4d56-99e8-31edb1a7d52a', '[855,770,465]', 'fixture-model', '2026-09-30 16:10:28.398104+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '7a65904e-aa1f-4438-9fa2-702c1d6fb953', '[855,771,466]', 'fixture-model', '2026-09-30 16:10:28.400228+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '75e7ec0d-7c97-455d-828a-7be812c96d5a', '[855,767,467]', 'fixture-model', '2026-09-30 16:10:28.402402+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '2ad5f6f4-6af3-480a-963d-c2581e800298', '[855,768,468]', 'fixture-model', '2026-09-30 16:10:28.404497+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '7f850fd5-b588-4e98-810e-61880d17f5dc', '[0,0,0]', 'fixture-model', '2026-09-30 16:10:28.407692+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '52352eb6-6c20-449b-bde9-92ceefad2119', '[855,770,470]', 'fixture-model', '2026-09-30 16:10:28.410587+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '790d7bb0-7be7-410d-a875-69d94b4bd0ff', '[855,771,471]', 'fixture-model', '2026-09-30 16:10:28.41329+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'd21a2085-0e80-481f-8a1a-47d62e379080', '[855,768,462]', 'fixture-model', '2026-09-30 16:10:28.415957+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '5a7107e4-b415-4912-a260-b5ba85543982', '[855,769,463]', 'fixture-model', '2026-09-30 16:10:28.418626+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', 'decede7e-0883-47c7-a8e3-0333baa2b19c', '[855,770,464]', 'fixture-model', '2026-09-30 16:10:28.421449+09');
INSERT INTO public.memory_embeddings_test_fixture_model_3 VALUES ('tenant-a', '8f147a2c-4cb8-4320-a1b6-db425fdad60b', '[855,771,465]', 'fixture-model', '2026-09-30 16:10:28.423792+09');


--
-- Data for Name: memory_embeddings_testkit_deterministic_8; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '602d957e-cff9-425f-b386-8565c7af9783', '[839,69,404,38,174,703,638,168]', 'deterministic', '2026-09-30 16:10:28.553218+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '98523396-eb33-468d-adbe-fd392d2bbb55', '[839,69,404,39,174,704,638,168]', 'deterministic', '2026-09-30 16:10:28.555532+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '9d84c4ff-7580-46dd-a1f4-25701838f3a3', '[839,69,404,40,174,705,638,168]', 'deterministic', '2026-09-30 16:10:28.557362+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'a8bdd009-902e-4d8e-aa86-46533de82784', '[0,0,0,0,0,0,0,0]', 'deterministic', '2026-09-30 16:10:28.559541+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '940d5ae2-af46-4c68-8032-e2913994003f', '[839,69,404,42,174,707,638,168]', 'deterministic', '2026-09-30 16:10:28.561383+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'a7b25522-dfdd-472c-b6d7-94186b139d05', '[839,69,404,38,174,708,638,168]', 'deterministic', '2026-09-30 16:10:28.563339+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '30d58bb2-fc98-4a76-ad29-9ce67eaab64c', '[839,69,404,39,174,709,638,168]', 'deterministic', '2026-09-30 16:10:28.56504+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'af28ef0f-9e57-4941-a5d7-100fb2d99d1c', '[839,69,404,40,174,710,638,168]', 'deterministic', '2026-09-30 16:10:28.566765+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '7b425243-9d71-4795-9cff-6ed41ca62635', '[839,69,404,41,174,711,638,168]', 'deterministic', '2026-09-30 16:10:28.568735+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'd9097e76-d0e1-4463-b9c3-32da098ab361', '[839,69,404,42,174,712,638,168]', 'deterministic', '2026-09-30 16:10:28.570416+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '1c0582e1-781b-43de-875c-39424f4a606c', '[0,0,0,0,0,0,0,0]', 'deterministic', '2026-09-30 16:10:28.572056+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '8827e601-7f09-43cf-beb7-51fb0a6ca239', '[218,229,101,23,993,197,634,691]', 'deterministic', '2026-09-30 16:10:28.57528+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '3805ce1a-03ae-4ee7-9ffb-3dbab94f05e1', '[218,229,101,23,994,197,635,691]', 'deterministic', '2026-09-30 16:10:28.588468+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'e063c891-63b5-427c-9678-484e0cfec148', '[218,229,101,23,995,197,636,691]', 'deterministic', '2026-09-30 16:10:28.590745+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', '0ad4b72a-6e8a-47f5-a17b-5a15e8480e25', '[218,229,101,23,991,197,637,691]', 'deterministic', '2026-09-30 16:10:28.592671+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'f2ab6369-c531-4f9f-89d1-93c0ec5b6967', '[218,229,101,23,992,197,638,691]', 'deterministic', '2026-09-30 16:10:28.594677+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-b', 'b6b09149-9e0a-44ea-8d8e-5e398a2b28c2', '[0,0,0,0,0,0,0,0]', 'deterministic', '2026-09-30 16:10:28.596602+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '5edcbe69-cc3f-4cd1-a611-a0bc6da517c6', '[236,824,78,391,51,180,632,690]', 'deterministic', '2026-09-30 16:10:28.752806+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '9e33ee7a-e83d-45c2-8d50-0e5fadc3e5db', '[236,824,78,391,52,180,633,690]', 'deterministic', '2026-09-30 16:10:28.755123+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '4f45de75-e881-4856-8d05-aad412e744c3', '[236,824,78,391,53,180,634,690]', 'deterministic', '2026-09-30 16:10:28.756811+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '5cd10797-6df6-49d8-8eb4-e901fc41cc7c', '[0,0,0,0,0,0,0,0]', 'deterministic', '2026-09-30 16:10:28.758434+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', 'f8bdff5b-da7e-48aa-802f-f5ca4eb792be', '[236,824,78,391,55,180,636,690]', 'deterministic', '2026-09-30 16:10:28.760172+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '9125e691-5d32-4e89-bee6-2a2d96ca3235', '[236,824,78,391,51,180,637,690]', 'deterministic', '2026-09-30 16:10:28.762009+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '97981b11-aee7-45ea-a2eb-c24d3eae9ce2', '[236,824,78,391,52,180,638,690]', 'deterministic', '2026-09-30 16:10:28.763749+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '287a2f8e-9486-426b-8adf-c18e9f02f01e', '[236,824,78,391,53,180,639,690]', 'deterministic', '2026-09-30 16:10:28.765258+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '04080c4e-4828-478f-a4fc-9fce71877410', '[236,824,78,391,54,180,640,690]', 'deterministic', '2026-09-30 16:10:28.766798+09');
INSERT INTO public.memory_embeddings_testkit_deterministic_8 VALUES ('tenant-a2', '09458b38-45e0-424f-b606-f422bca00e46', '[236,824,78,391,55,180,641,690]', 'deterministic', '2026-09-30 16:10:28.768565+09');


--
-- Data for Name: memory_events; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.memory_events VALUES ('7e44bdf7-b249-4ce5-96ee-3b4aa000b49c', 'tenant-a', 'e9b4837a-7259-4c1f-ac42-623c40b65da8', 'created', '2026-09-30 16:10:28.25+09', '{"type": "system"}', 'tenant-a の記憶 0 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "3170047c-439d-437b-80dd-f37d57c1609b"}');
INSERT INTO public.memory_events VALUES ('a35abd99-2c1d-43eb-a71a-e1bbf36fc00c', 'tenant-a', '385ddb84-f30d-45b6-a610-a90f4fa542da', 'created', '2026-09-30 16:10:28.257+09', '{"type": "system"}', 'tenant-a の記憶 1 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "f99381d3-2ff9-42d8-b89c-cb65bd5555ab"}');
INSERT INTO public.memory_events VALUES ('a9c29f5f-2452-4e2d-ab63-923e05b64234', 'tenant-a', 'cdaec7f7-e905-4944-bea0-efbd5313f206', 'created', '2026-09-30 16:10:28.262+09', '{"type": "system"}', 'tenant-a の記憶 2 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "d91ffdbc-7a8f-4d90-8533-7ac380bf84f5"}');
INSERT INTO public.memory_events VALUES ('4c14e938-ae40-4d12-9501-fd2e12e537fc', 'tenant-a', 'd6871336-2ab3-4100-81c0-1418236588ac', 'created', '2026-09-30 16:10:28.268+09', '{"type": "system"}', 'tenant-a の記憶 3 東京 会議 プロジェクト3 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "7c50d0b1-82ce-4d1b-a658-b174282aa4e1"}');
INSERT INTO public.memory_events VALUES ('d607e1da-595c-4292-a754-6afc5cfb661b', 'tenant-a', 'bdf590b6-cdf8-4f7f-9747-f274d8e039de', 'created', '2026-09-30 16:10:28.272+09', '{"type": "system"}', 'tenant-a の記憶 4 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "e5f562cf-fe5b-491e-8cbc-6a6c6c3d208c"}');
INSERT INTO public.memory_events VALUES ('607861cd-d12d-4b6d-a4f7-1f833ed03c13', 'tenant-a', '9f6e751a-d10d-4867-894c-3b3318fc5ad6', 'created', '2026-09-30 16:10:28.277+09', '{"type": "system"}', 'tenant-a の記憶 5 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "a46b840f-5880-4307-8d8c-6deda5af7cde"}');
INSERT INTO public.memory_events VALUES ('2e65649f-29a5-4c54-899e-7f4360b0d64a', 'tenant-a', '71959e35-ff92-4e32-a488-24ac50e52e23', 'created', '2026-09-30 16:10:28.285+09', '{"type": "system"}', 'tenant-a の記憶 6 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "8756c4a3-1be5-4269-9a40-8e7954d47b0c"}');
INSERT INTO public.memory_events VALUES ('16e99ef5-23f7-43a3-91bc-18fec36d8174', 'tenant-a', '6c000d76-3068-4f9a-b7f2-bf49c407604c', 'created', '2026-09-30 16:10:28.29+09', '{"type": "system"}', 'tenant-a の記憶 7 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "537fcfb1-864a-4d2d-a3a4-1bccc4cae503"}');
INSERT INTO public.memory_events VALUES ('28cb5aca-c7a7-459c-aba2-856c499bb4aa', 'tenant-a', 'db52e2d3-3a70-4031-b38b-99a212ee5ce5', 'created', '2026-09-30 16:10:28.295+09', '{"type": "system"}', 'tenant-a の記憶 8 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "ac48f49d-1570-40ff-a858-fd995fbbafa5"}');
INSERT INTO public.memory_events VALUES ('ec3e2df2-8215-432f-890c-ffad376e8031', 'tenant-a', 'b7a747ef-2733-4e8e-8e98-b8daaf0d1c49', 'created', '2026-09-30 16:10:28.299+09', '{"type": "system"}', 'tenant-a の記憶 9 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "1c44e415-8ff0-4944-9021-367f57dc6ded"}');
INSERT INTO public.memory_events VALUES ('cb77b674-442c-488e-8d1e-993b0ac77b9c', 'tenant-a', '0254ee12-a693-40d1-97ab-6d11e591459a', 'created', '2026-09-30 16:10:28.303+09', '{"type": "system"}', 'tenant-a の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "c18fb4a4-06af-4366-b8fe-f8bad0522dcc"}');
INSERT INTO public.memory_events VALUES ('54cff3e1-03c9-4ce8-809c-d76b55a5ef69', 'tenant-a', 'b5bbe07f-7133-4192-ad0a-b7ce2d75dd27', 'created', '2026-09-30 16:10:28.307+09', '{"type": "system"}', 'tenant-a の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "ec2abc0b-10d4-4578-a585-71d85c50227f"}');
INSERT INTO public.memory_events VALUES ('49bd7fd8-0827-4b36-8da6-4ae59ed8992f', 'tenant-a', 'f3153b73-6258-450f-ae4a-19807dbacb14', 'created', '2026-09-30 16:10:28.311+09', '{"type": "system"}', 'tenant-a の記憶 12 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "c3c2bdc0-9096-4579-b816-eba93a376bc1"}');
INSERT INTO public.memory_events VALUES ('997dc061-2426-449f-9f25-faa71a01f41c', 'tenant-a', '0142288a-451a-4d56-99e8-31edb1a7d52a', 'created', '2026-09-30 16:10:28.315+09', '{"type": "system"}', 'tenant-a の記憶 13 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "d50c9727-c674-4dcc-8c4b-0f2b7a52a38d"}');
INSERT INTO public.memory_events VALUES ('d13d878f-0778-45d0-b572-7d326799236a', 'tenant-a', '7a65904e-aa1f-4438-9fa2-702c1d6fb953', 'created', '2026-09-30 16:10:28.319+09', '{"type": "system"}', 'tenant-a の記憶 14 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "5c62a7cc-5ea8-4fe3-a984-d6a92e289dc3"}');
INSERT INTO public.memory_events VALUES ('a76c6a18-696b-4919-966a-735e4d58d6fa', 'tenant-a', '75e7ec0d-7c97-455d-828a-7be812c96d5a', 'created', '2026-09-30 16:10:28.322+09', '{"type": "system"}', 'tenant-a の記憶 15 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "0f9124f0-75e0-4f90-a837-964a8a73e741"}');
INSERT INTO public.memory_events VALUES ('1b3fb2bb-4d3a-449a-b8c5-8638902efb3d', 'tenant-a', '2ad5f6f4-6af3-480a-963d-c2581e800298', 'created', '2026-09-30 16:10:28.328+09', '{"type": "system"}', 'tenant-a の記憶 16 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "8fa787c0-15d5-45cd-a8ef-82614da0e289"}');
INSERT INTO public.memory_events VALUES ('59b1579b-969f-47a2-829e-53715c0aa441', 'tenant-a', '7f850fd5-b588-4e98-810e-61880d17f5dc', 'created', '2026-09-30 16:10:28.332+09', '{"type": "system"}', 'tenant-a の記憶 17 東京 会議 プロジェクト2 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "664ba403-7c58-4a1c-baf6-0a57e1743de5"}');
INSERT INTO public.memory_events VALUES ('f12ffc97-5343-4b8d-95df-ee79d37e0b72', 'tenant-a', '52352eb6-6c20-449b-bde9-92ceefad2119', 'created', '2026-09-30 16:10:28.335+09', '{"type": "system"}', 'tenant-a の記憶 18 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "de056da7-0494-49d4-a6af-df0bb6457a04"}');
INSERT INTO public.memory_events VALUES ('12304246-5852-4dac-aea3-477cc184e206', 'tenant-a', '790d7bb0-7be7-410d-a875-69d94b4bd0ff', 'created', '2026-09-30 16:10:28.342+09', '{"type": "system"}', 'tenant-a の記憶 19 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "2a678390-3e9f-4a00-ad81-d9b9f96da5e4"}');
INSERT INTO public.memory_events VALUES ('bafa4330-ce8b-4558-96e4-07b59b7abcb3', 'tenant-a', 'd21a2085-0e80-481f-8a1a-47d62e379080', 'created', '2026-09-30 16:10:28.346+09', '{"type": "system"}', 'tenant-a の記憶 20 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "85a364b0-30e9-4351-a444-0c65189167bc"}');
INSERT INTO public.memory_events VALUES ('a23f63dc-8a5a-4fa1-bd8a-c91d7127d1a5', 'tenant-a', '5a7107e4-b415-4912-a260-b5ba85543982', 'created', '2026-09-30 16:10:28.349+09', '{"type": "system"}', 'tenant-a の記憶 21 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "2533acb4-2f6e-476b-a555-e5cb3006169b"}');
INSERT INTO public.memory_events VALUES ('5f32ef90-b5ce-4496-bb3e-58466a0cf21b', 'tenant-a', 'decede7e-0883-47c7-a8e3-0333baa2b19c', 'created', '2026-09-30 16:10:28.353+09', '{"type": "system"}', 'tenant-a の記憶 22 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "8c3dffc1-e5ff-4131-8377-a8c800508a4d"}');
INSERT INTO public.memory_events VALUES ('5fdde0e3-f5d0-46a5-87bf-a9ba34d125e7', 'tenant-a', '8f147a2c-4cb8-4320-a1b6-db425fdad60b', 'created', '2026-09-30 16:10:28.356+09', '{"type": "system"}', 'tenant-a の記憶 23 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "aef701a6-ee0b-4360-89bf-a2221fac242f"}');
INSERT INTO public.memory_events VALUES ('47e0b824-44f8-446e-a4a1-c96ae0073f55', 'tenant-a', '8688815a-d446-472b-beed-78717974d078', 'created', '2026-09-30 16:10:28.36+09', '{"type": "system"}', 'tenant-a FAIL 埋め込み失敗 東京', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "9576c6dd-dd9f-48d1-8d99-a19d430e838f"}');
INSERT INTO public.memory_events VALUES ('0449ac97-7a22-484c-a174-5ab26ba531d1', 'tenant-a', 'fd3d3f38-8d19-4f69-bc0c-bde37829b600', 'created', '2026-09-30 16:10:28.43+09', '{"type": "system"}', 'tenant-a 未埋め込み 0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "e7630a70-a4a2-496e-ad49-2fbe7fa6422f"}');
INSERT INTO public.memory_events VALUES ('5479bc5c-495a-459d-9bbe-680c2078d54d', 'tenant-a', '19e371cd-0bc5-4a2e-bdd3-926c3e06a039', 'created', '2026-09-30 16:10:28.435+09', '{"type": "system"}', 'tenant-a 未埋め込み 1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "3892bb50-d13f-49a3-9f5b-9bccc4ec8aab"}');
INSERT INTO public.memory_events VALUES ('84029270-1d2f-490c-968e-7b1658b4bf47', 'tenant-a', 'a473bc10-58af-4d43-a483-98ae7237f4cd', 'created', '2026-09-30 16:10:28.443+09', '{"type": "system"}', 'tenant-a 未埋め込み 2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "9226deb4-9efe-4dd5-b839-41b0e73223e8"}');
INSERT INTO public.memory_events VALUES ('c9dfedb7-2e0c-473a-a35c-5a6cdc18cb7d', 'tenant-a', '71959e35-ff92-4e32-a488-24ac50e52e23', 'updated', '2026-09-30 16:10:28.45+09', '{"type": "system"}', 'tenant-a の記憶 6 東京 会議 プロジェクト1', NULL, '{"note": "fixture", "reason": "contested"}');
INSERT INTO public.memory_events VALUES ('2edc573f-2c04-47a0-980c-f06af1fa0727', 'tenant-a', 'db52e2d3-3a70-4031-b38b-99a212ee5ce5', 'updated', '2026-09-30 16:10:28.45+09', '{"type": "system"}', 'tenant-a の記憶 8 東京 会議 プロジェクト3', NULL, '{"note": "fixture", "reason": "contested"}');
INSERT INTO public.memory_events VALUES ('a4fc33ee-5e5f-4ddb-8be2-0da60f59a5f9', 'tenant-a', '0254ee12-a693-40d1-97ab-6d11e591459a', 'forgotten', '2026-09-30 16:10:28.453+09', '{"type": "system"}', 'tenant-a の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('d375c271-c74a-42f5-997f-e3f63954a788', 'tenant-a', 'b5bbe07f-7133-4192-ad0a-b7ce2d75dd27', 'forgotten', '2026-09-30 16:10:28.454+09', '{"type": "system"}', 'tenant-a の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('a5816647-fd3c-4887-a839-4b5029024250', 'tenant-a', 'b5bbe07f-7133-4192-ad0a-b7ce2d75dd27', 'purged', '2026-09-30 16:10:28.456+09', '{"type": "system"}', 'tenant-a の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('726da391-bcc3-428d-ae6f-6d55c9eb4cf1', 'tenant-b', '602d957e-cff9-425f-b386-8565c7af9783', 'created', '2026-09-30 16:10:28.48+09', '{"type": "system"}', 'tenant-b の記憶 0 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "52476b9e-6649-4fb3-a330-3a955c0a4ae3"}');
INSERT INTO public.memory_events VALUES ('cbd2d8d3-4a9d-4341-af10-8d7b73906449', 'tenant-b', '98523396-eb33-468d-adbe-fd392d2bbb55', 'created', '2026-09-30 16:10:28.484+09', '{"type": "system"}', 'tenant-b の記憶 1 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "798a8f2c-2e86-42f3-97e1-40d12069a4ab"}');
INSERT INTO public.memory_events VALUES ('48b6e79a-9c78-46a5-8b24-44061b3604c0', 'tenant-b', '9d84c4ff-7580-46dd-a1f4-25701838f3a3', 'created', '2026-09-30 16:10:28.488+09', '{"type": "system"}', 'tenant-b の記憶 2 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "fcae1158-de44-475b-bbe4-2ad40dad448a"}');
INSERT INTO public.memory_events VALUES ('b75a9cb6-8fdc-481e-b411-72c6e31df2d1', 'tenant-b', 'a8bdd009-902e-4d8e-aa86-46533de82784', 'created', '2026-09-30 16:10:28.492+09', '{"type": "system"}', 'tenant-b の記憶 3 東京 会議 プロジェクト3 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "8632e4e1-89ec-4179-812f-afe323083eea"}');
INSERT INTO public.memory_events VALUES ('d8a7e235-ab48-4f1a-82a2-23c5533b2a2a', 'tenant-b', '940d5ae2-af46-4c68-8032-e2913994003f', 'created', '2026-09-30 16:10:28.496+09', '{"type": "system"}', 'tenant-b の記憶 4 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "026eb916-b6c1-4e5a-be18-172f4bc6730a"}');
INSERT INTO public.memory_events VALUES ('1bfa9249-35ef-4067-85d5-c7fab4323dbf', 'tenant-b', 'a7b25522-dfdd-472c-b6d7-94186b139d05', 'created', '2026-09-30 16:10:28.5+09', '{"type": "system"}', 'tenant-b の記憶 5 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "33eb90de-ce69-42c0-860c-27f0c484da6f"}');
INSERT INTO public.memory_events VALUES ('90efaea9-ef75-44e9-971c-a33ca18148d8', 'tenant-b', '30d58bb2-fc98-4a76-ad29-9ce67eaab64c', 'created', '2026-09-30 16:10:28.504+09', '{"type": "system"}', 'tenant-b の記憶 6 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "69100d7a-9aed-4d47-a4ec-2b62dab54515"}');
INSERT INTO public.memory_events VALUES ('f42a9644-e056-4c82-af8b-f8a314a1d94c', 'tenant-b', 'af28ef0f-9e57-4941-a5d7-100fb2d99d1c', 'created', '2026-09-30 16:10:28.507+09', '{"type": "system"}', 'tenant-b の記憶 7 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "3b8f0f8b-1255-4153-a26e-79ab9314be25"}');
INSERT INTO public.memory_events VALUES ('1347d086-1d97-43cd-8ffe-e5061011dce7', 'tenant-b', '7b425243-9d71-4795-9cff-6ed41ca62635', 'created', '2026-09-30 16:10:28.511+09', '{"type": "system"}', 'tenant-b の記憶 8 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "3c85995e-851b-40b3-8cc6-b9a03bd79856"}');
INSERT INTO public.memory_events VALUES ('6ec218b9-8380-44a3-a0b5-efcaab3d0c71', 'tenant-b', 'd9097e76-d0e1-4463-b9c3-32da098ab361', 'created', '2026-09-30 16:10:28.514+09', '{"type": "system"}', 'tenant-b の記憶 9 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "c1a4bde9-7e9c-41ea-a82f-4aec9a396fe8"}');
INSERT INTO public.memory_events VALUES ('b703f655-f269-4bfd-9de1-044ce698ca23', 'tenant-b', '1c0582e1-781b-43de-875c-39424f4a606c', 'created', '2026-09-30 16:10:28.519+09', '{"type": "system"}', 'tenant-b の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "17fcbc7c-d5a2-4720-beed-f0f30c710c55"}');
INSERT INTO public.memory_events VALUES ('da51c408-5ef7-4635-9392-35e093da07a4', 'tenant-b', '34e46d3e-27d1-49bd-ac5e-00b8303fbb1c', 'created', '2026-09-30 16:10:28.524+09', '{"type": "system"}', 'tenant-b の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "1177f4a6-6f2f-46b8-bf1b-5f0753770719"}');
INSERT INTO public.memory_events VALUES ('cc81994a-3ded-45a9-8a4c-1afe02766798', 'tenant-b', '8827e601-7f09-43cf-beb7-51fb0a6ca239', 'created', '2026-09-30 16:10:28.528+09', '{"type": "system"}', 'tenant-b の記憶 12 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "af48aad9-78f1-4698-8d50-51e6acb5d770"}');
INSERT INTO public.memory_events VALUES ('4ef0bfc2-db9f-4efa-a6a4-c3180465e4a1', 'tenant-b', '3805ce1a-03ae-4ee7-9ffb-3dbab94f05e1', 'created', '2026-09-30 16:10:28.532+09', '{"type": "system"}', 'tenant-b の記憶 13 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "1d9b8833-240b-4111-a2ec-c2909189414e"}');
INSERT INTO public.memory_events VALUES ('8f71f3da-81ad-440a-a621-41b237839cc1', 'tenant-b', 'e063c891-63b5-427c-9678-484e0cfec148', 'created', '2026-09-30 16:10:28.536+09', '{"type": "system"}', 'tenant-b の記憶 14 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "70350c04-99e7-44c6-993c-dc5f8fc83b40"}');
INSERT INTO public.memory_events VALUES ('6869b505-9ff6-47ef-b595-26879a589a8c', 'tenant-b', '0ad4b72a-6e8a-47f5-a17b-5a15e8480e25', 'created', '2026-09-30 16:10:28.539+09', '{"type": "system"}', 'tenant-b の記憶 15 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "841735b6-59d7-47c6-a884-c255db80e9f9"}');
INSERT INTO public.memory_events VALUES ('242540dd-5ad2-4b7d-846e-6d465f3c6e5d', 'tenant-b', 'f2ab6369-c531-4f9f-89d1-93c0ec5b6967', 'created', '2026-09-30 16:10:28.543+09', '{"type": "system"}', 'tenant-b の記憶 16 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "17885792-b3d3-46e3-9351-4081ac0990e4"}');
INSERT INTO public.memory_events VALUES ('0147cd58-b4fd-47f7-be5e-d2273d5c9064', 'tenant-b', 'b6b09149-9e0a-44ea-8d8e-5e398a2b28c2', 'created', '2026-09-30 16:10:28.546+09', '{"type": "system"}', 'tenant-b の記憶 17 東京 会議 プロジェクト2 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "d51c6fcb-ee2d-4ba9-8409-fb31ac5b49c4"}');
INSERT INTO public.memory_events VALUES ('119c8dbe-c657-40b8-bdcd-d2ea0b1d7e57', 'tenant-b', '464f2fd3-d8aa-4282-a8e2-81c77162e584', 'created', '2026-09-30 16:10:28.55+09', '{"type": "system"}', 'tenant-b FAIL 埋め込み失敗 東京', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "f43f47cf-cd0c-401a-aa17-f34da5870c58"}');
INSERT INTO public.memory_events VALUES ('5f9bee3b-50e6-4e06-8cf5-1a44952a07a9', 'tenant-b', '6b031499-48ac-43ea-809f-9e706588e681', 'created', '2026-09-30 16:10:28.602+09', '{"type": "system"}', 'tenant-b 未埋め込み 0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "21dc8ea7-d9db-45ea-b661-8c717990146d"}');
INSERT INTO public.memory_events VALUES ('2656fb95-e5c7-450a-96e7-546693e9c47b', 'tenant-b', 'f4732ff5-ac81-4824-8b4c-b4fab0e0ccec', 'created', '2026-09-30 16:10:28.607+09', '{"type": "system"}', 'tenant-b 未埋め込み 1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "31592c08-72fb-4b86-ba57-3277ebb273e4"}');
INSERT INTO public.memory_events VALUES ('c411078f-278a-4fcb-8b6d-8ce35b95caee', 'tenant-b', '3d8b7a59-9446-4c53-9ae9-c289e288ca6f', 'created', '2026-09-30 16:10:28.611+09', '{"type": "system"}', 'tenant-b 未埋め込み 2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "47928993-378d-4d18-a28a-d594a9e8a19e"}');
INSERT INTO public.memory_events VALUES ('60ffaa92-8d04-428a-8d08-1ec56c65684d', 'tenant-b', '30d58bb2-fc98-4a76-ad29-9ce67eaab64c', 'updated', '2026-09-30 16:10:28.615+09', '{"type": "system"}', 'tenant-b の記憶 6 東京 会議 プロジェクト1', NULL, '{"note": "fixture", "reason": "contested"}');
INSERT INTO public.memory_events VALUES ('665da510-1723-412f-bde9-fd04be8b9ce4', 'tenant-b', '7b425243-9d71-4795-9cff-6ed41ca62635', 'updated', '2026-09-30 16:10:28.616+09', '{"type": "system"}', 'tenant-b の記憶 8 東京 会議 プロジェクト3', NULL, '{"note": "fixture", "reason": "contested"}');
INSERT INTO public.memory_events VALUES ('96afbe18-9f7f-4fcb-a05f-39c0e90a9bcc', 'tenant-b', '1c0582e1-781b-43de-875c-39424f4a606c', 'forgotten', '2026-09-30 16:10:28.618+09', '{"type": "system"}', 'tenant-b の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('af82df12-d68b-441c-9512-f477886230c8', 'tenant-b', '34e46d3e-27d1-49bd-ac5e-00b8303fbb1c', 'forgotten', '2026-09-30 16:10:28.619+09', '{"type": "system"}', 'tenant-b の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('af3d3cf0-bf00-499e-9ba1-cc417c79ab3d', 'tenant-b', '34e46d3e-27d1-49bd-ac5e-00b8303fbb1c', 'purged', '2026-09-30 16:10:28.62+09', '{"type": "system"}', 'tenant-b の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('66271f78-2ecf-4ed8-bca6-7cb70380835f', 'tenant-b', '7b425243-9d71-4795-9cff-6ed41ca62635', 'forgotten', '2026-09-30 16:10:28.622+09', '{"type": "system"}', 'tenant-b の記憶 8 東京 会議 プロジェクト3', NULL, '{"reason": "fixture: orphaned contested"}');
INSERT INTO public.memory_events VALUES ('e00db0b1-9f6a-4f4a-aeb8-122e33b1c2d8', 'tenant-c', '67a19942-fd02-4e21-b29c-fe6c3235e52e', 'created', '2026-09-30 16:10:28.631+09', '{"type": "system"}', 'tenant-c の記憶 0 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "897e33f9-7abb-4c13-ab9c-379816fc8531"}');
INSERT INTO public.memory_events VALUES ('fce72d53-c428-44ab-b9e0-e17f8ad7018e', 'tenant-c', 'bcd20266-65d9-4d90-b8fe-4eee19f5d0b7', 'created', '2026-09-30 16:10:28.635+09', '{"type": "system"}', 'tenant-c の記憶 1 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "5d5df62e-7088-47c7-b444-425dce000eda"}');
INSERT INTO public.memory_events VALUES ('db42dc8d-a447-4df0-8a42-e152b8d1ccca', 'tenant-c', '86537f40-a1c3-4777-a868-66f1622eb652', 'created', '2026-09-30 16:10:28.639+09', '{"type": "system"}', 'tenant-c の記憶 2 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "404a82bf-e9c1-44fc-8cd9-cbff2c2fd200"}');
INSERT INTO public.memory_events VALUES ('8eb833a0-e74a-46ce-9826-c2865a98c6a1', 'tenant-c', 'e7dc9134-bf43-46b6-ad48-1530fadfddff', 'created', '2026-09-30 16:10:28.641+09', '{"type": "system"}', 'tenant-c の記憶 3 東京 会議 プロジェクト3 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "a7bf69ac-0b74-4a20-9480-4045f3eb604e"}');
INSERT INTO public.memory_events VALUES ('de508820-8463-4679-bffc-647ab2d51120', 'tenant-c', '957b1f8d-0583-4845-91c4-c1dc47b5e4b1', 'created', '2026-09-30 16:10:28.644+09', '{"type": "system"}', 'tenant-c の記憶 4 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "174d4196-adcf-4868-bdd6-586ba61c3689"}');
INSERT INTO public.memory_events VALUES ('b779dab6-f41c-40f1-b6c8-03c273f65400', 'tenant-c', '9a51add5-7e2b-401b-abcd-1c425efaab64', 'created', '2026-09-30 16:10:28.647+09', '{"type": "system"}', 'tenant-c の記憶 5 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "2308068d-6d20-4e72-bedb-82b33db53c40"}');
INSERT INTO public.memory_events VALUES ('9181b8f7-07e3-4007-bd62-1ae4d96e7b84', 'tenant-c', '69eca64a-eb31-45e3-8ac8-d79a5590b8da', 'created', '2026-09-30 16:10:28.65+09', '{"type": "system"}', 'tenant-c の記憶 6 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "40c3d240-b305-4175-b58f-0eaa6e7bfdd5"}');
INSERT INTO public.memory_events VALUES ('cd95ba38-477d-47dd-9e09-f165d018a495', 'tenant-c', 'a5d1f82f-80cd-4f39-8067-47e16e0e8f6f', 'created', '2026-09-30 16:10:28.653+09', '{"type": "system"}', 'tenant-c の記憶 7 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "5261947b-df7f-4e75-b8d6-8a70cf1ddeb7"}');
INSERT INTO public.memory_events VALUES ('39aab935-9db3-447f-8be2-97173bd5ffa6', 'tenant-c', '91ce637e-a3a0-4936-909c-2c31d8d5b039', 'created', '2026-09-30 16:10:28.656+09', '{"type": "system"}', 'tenant-c の記憶 8 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "3e624c0a-ba29-479a-bdd9-b8bbc21243a8"}');
INSERT INTO public.memory_events VALUES ('791aef84-2aae-42cb-9c18-920d232e214c', 'tenant-c', '6aa8e0ff-f2b5-40ed-9c6e-abefb74a8ef7', 'created', '2026-09-30 16:10:28.658+09', '{"type": "system"}', 'tenant-c の記憶 9 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "cd9f3f9f-9d3f-474b-a5b8-1eceb426b359"}');
INSERT INTO public.memory_events VALUES ('b59aadaf-74c8-4548-8352-17b9d15abdf1', 'tenant-c', '04033cd4-9639-4081-aef9-c5f4edf9ec8b', 'created', '2026-09-30 16:10:28.661+09', '{"type": "system"}', 'tenant-c の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "b5f667ea-af53-4af9-bd22-e547e9bdafe8"}');
INSERT INTO public.memory_events VALUES ('6fbb3852-43f6-4152-ab8e-c91ba51d02c7', 'tenant-c', 'a00cde4a-97e6-4621-b312-1ab2065791f1', 'created', '2026-09-30 16:10:28.663+09', '{"type": "system"}', 'tenant-c の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "2aee3c82-20d1-468a-97bb-1939e439a832"}');
INSERT INTO public.memory_events VALUES ('53e84488-aa2b-4974-beee-ab95cc73e7a7', 'tenant-c', '6031bd81-b545-4b72-9737-2073ebdd0c42', 'created', '2026-09-30 16:10:28.666+09', '{"type": "system"}', 'tenant-c FAIL 埋め込み失敗 東京', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "4b686057-0886-4b17-ba86-458597b54aef"}');
INSERT INTO public.memory_events VALUES ('4f72d3b6-784c-413a-bfa0-af3075574089', 'tenant-c', '9efcc2f7-6130-4276-9b83-e64b09deaac3', 'created', '2026-09-30 16:10:28.693+09', '{"type": "system"}', 'tenant-c 未埋め込み 0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "fe42f01d-6aa4-4482-92de-2e34fcd3b584"}');
INSERT INTO public.memory_events VALUES ('e5963f0b-29a3-41f9-99c2-9c6e09da70ed', 'tenant-c', 'f6e5b0de-b8fc-457a-b825-8887d9e63931', 'created', '2026-09-30 16:10:28.696+09', '{"type": "system"}', 'tenant-c 未埋め込み 1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "482310e0-72f1-429a-8470-7391cd2b0cd8"}');
INSERT INTO public.memory_events VALUES ('dc55a9ad-c2a8-4c15-b857-89605399693f', 'tenant-c', 'aeb1c34f-fe5c-43ab-bfde-3af9000488f7', 'created', '2026-09-30 16:10:28.699+09', '{"type": "system"}', 'tenant-c 未埋め込み 2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "cf6fa671-3757-444e-bb02-52e573c9817d"}');
INSERT INTO public.memory_events VALUES ('acd6e3f5-4397-4ceb-912c-c8b3284cf35d', 'tenant-c', '69eca64a-eb31-45e3-8ac8-d79a5590b8da', 'updated', '2026-09-30 16:10:28.703+09', '{"type": "system"}', 'tenant-c の記憶 6 東京 会議 プロジェクト1', NULL, '{"note": "fixture", "reason": "contested"}');
INSERT INTO public.memory_events VALUES ('947e0cf9-a2f9-487b-ac87-9ac10fbfe935', 'tenant-c', '91ce637e-a3a0-4936-909c-2c31d8d5b039', 'updated', '2026-09-30 16:10:28.703+09', '{"type": "system"}', 'tenant-c の記憶 8 東京 会議 プロジェクト3', NULL, '{"note": "fixture", "reason": "contested"}');
INSERT INTO public.memory_events VALUES ('b3c9aa39-6366-4b51-9cf6-2c08548bb993', 'tenant-c', '04033cd4-9639-4081-aef9-c5f4edf9ec8b', 'forgotten', '2026-09-30 16:10:28.705+09', '{"type": "system"}', 'tenant-c の記憶 10 東京 会議 プロジェクト0 ZERO', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('153c54f9-9021-41a8-b45c-106c2cf1abad', 'tenant-c', 'a00cde4a-97e6-4621-b312-1ab2065791f1', 'forgotten', '2026-09-30 16:10:28.706+09', '{"type": "system"}', 'tenant-c の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('72151181-b1b4-4fe8-99bd-8f827b32a1ba', 'tenant-c', 'a00cde4a-97e6-4621-b312-1ab2065791f1', 'purged', '2026-09-30 16:10:28.707+09', '{"type": "system"}', 'tenant-c の記憶 11 東京 会議 プロジェクト1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('690f46d6-fe5a-4bff-a71b-e559db391532', 'tenant-c', '9a51add5-7e2b-401b-abcd-1c425efaab64', 'forgotten', '2026-09-30 16:10:28.709+09', '{"type": "system"}', 'tenant-c の記憶 5 東京 会議 プロジェクト0', NULL, '{"reason": "fixture: successor forgotten"}');
INSERT INTO public.memory_events VALUES ('e78a4a5b-30df-4ef2-a3ec-76db8cd79012', 'tenant-a2', '5edcbe69-cc3f-4cd1-a611-a0bc6da517c6', 'created', '2026-09-30 16:10:28.717+09', '{"type": "system"}', 'tenant-a2 の記憶 0 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "00146ece-dfb1-4c18-b274-f804695477f6"}');
INSERT INTO public.memory_events VALUES ('b284bf0a-c0e1-46e6-9674-4e5f6500da70', 'tenant-a2', '9e33ee7a-e83d-45c2-8d50-0e5fadc3e5db', 'created', '2026-09-30 16:10:28.721+09', '{"type": "system"}', 'tenant-a2 の記憶 1 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "69c45eab-23b5-4545-b619-1ed91221a75b"}');
INSERT INTO public.memory_events VALUES ('9bbdaa86-ff93-4c58-97db-a3065871eb7d', 'tenant-a2', '4f45de75-e881-4856-8d05-aad412e744c3', 'created', '2026-09-30 16:10:28.724+09', '{"type": "system"}', 'tenant-a2 の記憶 2 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "41504b63-b402-4ae1-9e79-abcb9e801955"}');
INSERT INTO public.memory_events VALUES ('fcaaa240-04ce-4d75-ab05-c8b327caaf64', 'tenant-a2', '5cd10797-6df6-49d8-8eb4-e901fc41cc7c', 'created', '2026-09-30 16:10:28.727+09', '{"type": "system"}', 'tenant-a2 の記憶 3 東京 会議 プロジェクト3 ZERO', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "6551e295-d41c-4f47-add8-6b2d23df0308"}');
INSERT INTO public.memory_events VALUES ('34232800-93c4-40be-ade0-7e176d2c4fe7', 'tenant-a2', 'f8bdff5b-da7e-48aa-802f-f5ca4eb792be', 'created', '2026-09-30 16:10:28.73+09', '{"type": "system"}', 'tenant-a2 の記憶 4 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "57b3e37b-cb8a-49f7-bd53-7fbf8708af81"}');
INSERT INTO public.memory_events VALUES ('180239c2-2837-4c61-bcb3-1a0543cf36d0', 'tenant-a2', '9125e691-5d32-4e89-bee6-2a2d96ca3235', 'created', '2026-09-30 16:10:28.733+09', '{"type": "system"}', 'tenant-a2 の記憶 5 東京 会議 プロジェクト0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "0ccc9173-835d-4bdb-a545-91e437ba77e3"}');
INSERT INTO public.memory_events VALUES ('f06f4a4a-599c-409d-bb6b-4094cfab2ce2', 'tenant-a2', '97981b11-aee7-45ea-a2eb-c24d3eae9ce2', 'created', '2026-09-30 16:10:28.736+09', '{"type": "system"}', 'tenant-a2 の記憶 6 東京 会議 プロジェクト1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "8074c4a0-3534-41ff-99f7-f66ab0e918c0"}');
INSERT INTO public.memory_events VALUES ('257d5e20-9996-4506-8785-75cd429bc182', 'tenant-a2', '287a2f8e-9486-426b-8adf-c18e9f02f01e', 'created', '2026-09-30 16:10:28.739+09', '{"type": "system"}', 'tenant-a2 の記憶 7 東京 会議 プロジェクト2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "1f53fa34-341b-4866-a248-7690e5a509f5"}');
INSERT INTO public.memory_events VALUES ('a5b69d07-ead7-43d4-969a-f3531d8258ba', 'tenant-a2', '04080c4e-4828-478f-a4fc-9fce71877410', 'created', '2026-09-30 16:10:28.743+09', '{"type": "system"}', 'tenant-a2 の記憶 8 東京 会議 プロジェクト3', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "a560737a-6d4c-4753-852f-844bd132ae23"}');
INSERT INTO public.memory_events VALUES ('635165f8-601a-4ae6-99fb-1731b6a1497e', 'tenant-a2', '09458b38-45e0-424f-b606-f422bca00e46', 'created', '2026-09-30 16:10:28.746+09', '{"type": "system"}', 'tenant-a2 の記憶 9 東京 会議 プロジェクト4', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "50516e9d-2dba-4bf8-be6c-8489bdd7f2e1"}');
INSERT INTO public.memory_events VALUES ('0882f2bc-4093-49d9-8bec-8f56c47d3608', 'tenant-a2', '51bcf032-4265-47d1-be97-7315e758f0f2', 'created', '2026-09-30 16:10:28.75+09', '{"type": "system"}', 'tenant-a2 FAIL 埋め込み失敗 東京', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "8f97f8b5-12b3-410f-b143-6eb05e4905da"}');
INSERT INTO public.memory_events VALUES ('a69dd4a6-fff5-4790-b7db-25f87dcc7bc0', 'tenant-a2', '37ca332a-60df-40b4-add5-0b80cc38dd49', 'created', '2026-09-30 16:10:28.773+09', '{"type": "system"}', 'tenant-a2 未埋め込み 0', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "a0534cb7-ee9a-4aac-aa48-af5da5eb4572"}');
INSERT INTO public.memory_events VALUES ('e5fb9a2e-b1f5-4ad9-a301-e345efd4277a', 'tenant-a2', 'f193d97d-23d3-4df2-aa57-e305e2196534', 'created', '2026-09-30 16:10:28.776+09', '{"type": "system"}', 'tenant-a2 未埋め込み 1', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "122bfe15-0289-4e27-85cd-f18a8aeba1c2"}');
INSERT INTO public.memory_events VALUES ('f4d04208-64de-40fb-8fc9-a8bc7a4738b6', 'tenant-a2', '66a93937-8913-4661-9b63-85c4f0877869', 'created', '2026-09-30 16:10:28.8+09', '{"type": "system"}', 'tenant-a2 未埋め込み 2', NULL, '{"reason": "extracted", "extractorVersion": "v1", "sourceObservationId": "143b2d68-cf0b-4510-9f37-64c91d0d6ee6"}');
INSERT INTO public.memory_events VALUES ('9362b34d-ebf8-46f2-a454-269063893536', 'tenant-a2', '97981b11-aee7-45ea-a2eb-c24d3eae9ce2', 'updated', '2026-09-30 16:10:28.804+09', '{"type": "system"}', 'tenant-a2 の記憶 6 東京 会議 プロジェクト1', NULL, '{"note": "fixture", "reason": "contested"}');
INSERT INTO public.memory_events VALUES ('6c4325c8-71a8-45a7-b058-8076bb1b8b6a', 'tenant-a2', '04080c4e-4828-478f-a4fc-9fce71877410', 'updated', '2026-09-30 16:10:28.804+09', '{"type": "system"}', 'tenant-a2 の記憶 8 東京 会議 プロジェクト3', NULL, '{"note": "fixture", "reason": "contested"}');
INSERT INTO public.memory_events VALUES ('b6920596-b704-411a-992b-c6a74785d804', 'tenant-a2', '37ca332a-60df-40b4-add5-0b80cc38dd49', 'forgotten', '2026-09-30 16:10:28.808+09', '{"type": "system"}', 'tenant-a2 未埋め込み 0', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('76831cb3-a78a-4b2f-874d-a92bb71371c0', 'tenant-a2', 'f193d97d-23d3-4df2-aa57-e305e2196534', 'forgotten', '2026-09-30 16:10:28.809+09', '{"type": "system"}', 'tenant-a2 未埋め込み 1', NULL, '{"reason": "fixture"}');
INSERT INTO public.memory_events VALUES ('da7bdf39-44a8-4666-b486-e8ad450b3c41', 'tenant-a2', 'f193d97d-23d3-4df2-aa57-e305e2196534', 'purged', '2026-09-30 16:10:28.811+09', '{"type": "system"}', 'tenant-a2 未埋め込み 1', NULL, '{"reason": "fixture"}');


--
-- Data for Name: observations; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.observations VALUES ('3170047c-439d-437b-80dd-f37d57c1609b', 'tenant-a', NULL, 'tenant-a-ext-0', 'utterance', '{"text": "tenant-a の記憶 0 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-30 16:10:28.235+09', NULL, NULL);
INSERT INTO public.observations VALUES ('f99381d3-2ff9-42d8-b89c-cb65bd5555ab', 'tenant-a', NULL, 'tenant-a-ext-1', 'utterance', '{"text": "tenant-a の記憶 1 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-30 16:10:28.253+09', NULL, NULL);
INSERT INTO public.observations VALUES ('d91ffdbc-7a8f-4d90-8533-7ac380bf84f5', 'tenant-a', NULL, 'tenant-a-ext-2', 'utterance', '{"text": "tenant-a の記憶 2 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-30 16:10:28.259+09', NULL, NULL);
INSERT INTO public.observations VALUES ('7c50d0b1-82ce-4d1b-a658-b174282aa4e1', 'tenant-a', NULL, 'tenant-a-ext-3', 'utterance', '{"text": "tenant-a の記憶 3 東京 会議 プロジェクト3 ZERO", "speaker": "user"}', NULL, '2026-09-30 16:10:28.264+09', NULL, NULL);
INSERT INTO public.observations VALUES ('e5f562cf-fe5b-491e-8cbc-6a6c6c3d208c', 'tenant-a', NULL, 'tenant-a-ext-4', 'utterance', '{"text": "tenant-a の記憶 4 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-30 16:10:28.269+09', NULL, NULL);
INSERT INTO public.observations VALUES ('a46b840f-5880-4307-8d8c-6deda5af7cde', 'tenant-a', NULL, 'tenant-a-ext-5', 'utterance', '{"text": "tenant-a の記憶 5 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-30 16:10:28.274+09', NULL, NULL);
INSERT INTO public.observations VALUES ('8756c4a3-1be5-4269-9a40-8e7954d47b0c', 'tenant-a', NULL, 'tenant-a-ext-6', 'utterance', '{"text": "tenant-a の記憶 6 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-30 16:10:28.279+09', NULL, NULL);
INSERT INTO public.observations VALUES ('537fcfb1-864a-4d2d-a3a4-1bccc4cae503', 'tenant-a', NULL, 'tenant-a-ext-7', 'utterance', '{"text": "tenant-a の記憶 7 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-30 16:10:28.286+09', NULL, NULL);
INSERT INTO public.observations VALUES ('ac48f49d-1570-40ff-a858-fd995fbbafa5', 'tenant-a', NULL, 'tenant-a-ext-8', 'utterance', '{"text": "tenant-a の記憶 8 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-30 16:10:28.292+09', NULL, NULL);
INSERT INTO public.observations VALUES ('1c44e415-8ff0-4944-9021-367f57dc6ded', 'tenant-a', NULL, 'tenant-a-ext-9', 'utterance', '{"text": "tenant-a の記憶 9 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-30 16:10:28.296+09', NULL, NULL);
INSERT INTO public.observations VALUES ('c18fb4a4-06af-4366-b8fe-f8bad0522dcc', 'tenant-a', NULL, 'tenant-a-ext-10', 'utterance', '{"text": "tenant-a の記憶 10 東京 会議 プロジェクト0 ZERO", "speaker": "user"}', NULL, '2026-09-30 16:10:28.3+09', NULL, NULL);
INSERT INTO public.observations VALUES ('ec2abc0b-10d4-4578-a585-71d85c50227f', 'tenant-a', NULL, 'tenant-a-ext-11', 'utterance', '{"text": "tenant-a の記憶 11 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-30 16:10:28.305+09', NULL, NULL);
INSERT INTO public.observations VALUES ('c3c2bdc0-9096-4579-b816-eba93a376bc1', 'tenant-a', NULL, 'tenant-a-ext-12', 'utterance', '{"text": "tenant-a の記憶 12 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-30 16:10:28.308+09', NULL, NULL);
INSERT INTO public.observations VALUES ('d50c9727-c674-4dcc-8c4b-0f2b7a52a38d', 'tenant-a', NULL, 'tenant-a-ext-13', 'utterance', '{"text": "tenant-a の記憶 13 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-30 16:10:28.312+09', NULL, NULL);
INSERT INTO public.observations VALUES ('5c62a7cc-5ea8-4fe3-a984-d6a92e289dc3', 'tenant-a', NULL, 'tenant-a-ext-14', 'utterance', '{"text": "tenant-a の記憶 14 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-30 16:10:28.316+09', NULL, NULL);
INSERT INTO public.observations VALUES ('0f9124f0-75e0-4f90-a837-964a8a73e741', 'tenant-a', NULL, 'tenant-a-ext-15', 'utterance', '{"text": "tenant-a の記憶 15 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-30 16:10:28.32+09', NULL, NULL);
INSERT INTO public.observations VALUES ('8fa787c0-15d5-45cd-a8ef-82614da0e289', 'tenant-a', NULL, 'tenant-a-ext-16', 'utterance', '{"text": "tenant-a の記憶 16 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-30 16:10:28.324+09', NULL, NULL);
INSERT INTO public.observations VALUES ('664ba403-7c58-4a1c-baf6-0a57e1743de5', 'tenant-a', NULL, 'tenant-a-ext-17', 'utterance', '{"text": "tenant-a の記憶 17 東京 会議 プロジェクト2 ZERO", "speaker": "user"}', NULL, '2026-09-30 16:10:28.329+09', NULL, NULL);
INSERT INTO public.observations VALUES ('de056da7-0494-49d4-a6af-df0bb6457a04', 'tenant-a', NULL, 'tenant-a-ext-18', 'utterance', '{"text": "tenant-a の記憶 18 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-30 16:10:28.333+09', NULL, NULL);
INSERT INTO public.observations VALUES ('2a678390-3e9f-4a00-ad81-d9b9f96da5e4', 'tenant-a', NULL, 'tenant-a-ext-19', 'utterance', '{"text": "tenant-a の記憶 19 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-30 16:10:28.339+09', NULL, NULL);
INSERT INTO public.observations VALUES ('85a364b0-30e9-4351-a444-0c65189167bc', 'tenant-a', NULL, 'tenant-a-ext-20', 'utterance', '{"text": "tenant-a の記憶 20 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-30 16:10:28.343+09', NULL, NULL);
INSERT INTO public.observations VALUES ('2533acb4-2f6e-476b-a555-e5cb3006169b', 'tenant-a', NULL, 'tenant-a-ext-21', 'utterance', '{"text": "tenant-a の記憶 21 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-30 16:10:28.347+09', NULL, NULL);
INSERT INTO public.observations VALUES ('8c3dffc1-e5ff-4131-8377-a8c800508a4d', 'tenant-a', NULL, 'tenant-a-ext-22', 'utterance', '{"text": "tenant-a の記憶 22 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-30 16:10:28.35+09', NULL, NULL);
INSERT INTO public.observations VALUES ('aef701a6-ee0b-4360-89bf-a2221fac242f', 'tenant-a', NULL, 'tenant-a-ext-23', 'utterance', '{"text": "tenant-a の記憶 23 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-30 16:10:28.354+09', NULL, NULL);
INSERT INTO public.observations VALUES ('9576c6dd-dd9f-48d1-8d99-a19d430e838f', 'tenant-a', NULL, NULL, 'utterance', '{"text": "tenant-a FAIL 埋め込み失敗 東京", "speaker": "user"}', NULL, '2026-09-30 16:10:28.357+09', NULL, NULL);
INSERT INTO public.observations VALUES ('e7630a70-a4a2-496e-ad49-2fbe7fa6422f', 'tenant-a', NULL, NULL, 'utterance', '{"text": "tenant-a 未埋め込み 0", "speaker": "user"}', NULL, '2026-09-30 16:10:28.427+09', NULL, NULL);
INSERT INTO public.observations VALUES ('3892bb50-d13f-49a3-9f5b-9bccc4ec8aab', 'tenant-a', NULL, NULL, 'utterance', '{"text": "tenant-a 未埋め込み 1", "speaker": "user"}', NULL, '2026-09-30 16:10:28.431+09', NULL, NULL);
INSERT INTO public.observations VALUES ('9226deb4-9efe-4dd5-b839-41b0e73223e8', 'tenant-a', NULL, NULL, 'utterance', '{"text": "tenant-a 未埋め込み 2", "speaker": "user"}', NULL, '2026-09-30 16:10:28.436+09', NULL, NULL);
INSERT INTO public.observations VALUES ('b2c3d538-4499-432f-b89c-03b5f4682c97', 'tenant-a', NULL, NULL, 'usage', '{"recallId": "a41c44fe-7ee5-4451-824e-bab2134f9fd0", "usedMemoryIds": ["d21a2085-0e80-481f-8a1a-47d62e379080"]}', NULL, '2026-09-30 16:10:28.472+09', NULL, NULL);
INSERT INTO public.observations VALUES ('52476b9e-6649-4fb3-a330-3a955c0a4ae3', 'tenant-b', NULL, 'tenant-b-ext-0', 'utterance', '{"text": "tenant-b の記憶 0 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-30 16:10:28.477+09', NULL, NULL);
INSERT INTO public.observations VALUES ('798a8f2c-2e86-42f3-97e1-40d12069a4ab', 'tenant-b', NULL, 'tenant-b-ext-1', 'utterance', '{"text": "tenant-b の記憶 1 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-30 16:10:28.481+09', NULL, NULL);
INSERT INTO public.observations VALUES ('fcae1158-de44-475b-bbe4-2ad40dad448a', 'tenant-b', NULL, 'tenant-b-ext-2', 'utterance', '{"text": "tenant-b の記憶 2 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-30 16:10:28.485+09', NULL, NULL);
INSERT INTO public.observations VALUES ('8632e4e1-89ec-4179-812f-afe323083eea', 'tenant-b', NULL, 'tenant-b-ext-3', 'utterance', '{"text": "tenant-b の記憶 3 東京 会議 プロジェクト3 ZERO", "speaker": "user"}', NULL, '2026-09-30 16:10:28.489+09', NULL, NULL);
INSERT INTO public.observations VALUES ('026eb916-b6c1-4e5a-be18-172f4bc6730a', 'tenant-b', NULL, 'tenant-b-ext-4', 'utterance', '{"text": "tenant-b の記憶 4 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-30 16:10:28.493+09', NULL, NULL);
INSERT INTO public.observations VALUES ('33eb90de-ce69-42c0-860c-27f0c484da6f', 'tenant-b', NULL, 'tenant-b-ext-5', 'utterance', '{"text": "tenant-b の記憶 5 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-30 16:10:28.497+09', NULL, NULL);
INSERT INTO public.observations VALUES ('69100d7a-9aed-4d47-a4ec-2b62dab54515', 'tenant-b', NULL, 'tenant-b-ext-6', 'utterance', '{"text": "tenant-b の記憶 6 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-30 16:10:28.501+09', NULL, NULL);
INSERT INTO public.observations VALUES ('3b8f0f8b-1255-4153-a26e-79ab9314be25', 'tenant-b', NULL, 'tenant-b-ext-7', 'utterance', '{"text": "tenant-b の記憶 7 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-30 16:10:28.505+09', NULL, NULL);
INSERT INTO public.observations VALUES ('3c85995e-851b-40b3-8cc6-b9a03bd79856', 'tenant-b', NULL, 'tenant-b-ext-8', 'utterance', '{"text": "tenant-b の記憶 8 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-30 16:10:28.508+09', NULL, NULL);
INSERT INTO public.observations VALUES ('c1a4bde9-7e9c-41ea-a82f-4aec9a396fe8', 'tenant-b', NULL, 'tenant-b-ext-9', 'utterance', '{"text": "tenant-b の記憶 9 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-30 16:10:28.512+09', NULL, NULL);
INSERT INTO public.observations VALUES ('17fcbc7c-d5a2-4720-beed-f0f30c710c55', 'tenant-b', NULL, 'tenant-b-ext-10', 'utterance', '{"text": "tenant-b の記憶 10 東京 会議 プロジェクト0 ZERO", "speaker": "user"}', NULL, '2026-09-30 16:10:28.516+09', NULL, NULL);
INSERT INTO public.observations VALUES ('1177f4a6-6f2f-46b8-bf1b-5f0753770719', 'tenant-b', NULL, 'tenant-b-ext-11', 'utterance', '{"text": "tenant-b の記憶 11 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-30 16:10:28.521+09', NULL, NULL);
INSERT INTO public.observations VALUES ('af48aad9-78f1-4698-8d50-51e6acb5d770', 'tenant-b', NULL, 'tenant-b-ext-12', 'utterance', '{"text": "tenant-b の記憶 12 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-30 16:10:28.525+09', NULL, NULL);
INSERT INTO public.observations VALUES ('1d9b8833-240b-4111-a2ec-c2909189414e', 'tenant-b', NULL, 'tenant-b-ext-13', 'utterance', '{"text": "tenant-b の記憶 13 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-30 16:10:28.529+09', NULL, NULL);
INSERT INTO public.observations VALUES ('70350c04-99e7-44c6-993c-dc5f8fc83b40', 'tenant-b', NULL, 'tenant-b-ext-14', 'utterance', '{"text": "tenant-b の記憶 14 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-30 16:10:28.533+09', NULL, NULL);
INSERT INTO public.observations VALUES ('841735b6-59d7-47c6-a884-c255db80e9f9', 'tenant-b', NULL, 'tenant-b-ext-15', 'utterance', '{"text": "tenant-b の記憶 15 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-30 16:10:28.537+09', NULL, NULL);
INSERT INTO public.observations VALUES ('17885792-b3d3-46e3-9351-4081ac0990e4', 'tenant-b', NULL, 'tenant-b-ext-16', 'utterance', '{"text": "tenant-b の記憶 16 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-30 16:10:28.54+09', NULL, NULL);
INSERT INTO public.observations VALUES ('d51c6fcb-ee2d-4ba9-8409-fb31ac5b49c4', 'tenant-b', NULL, 'tenant-b-ext-17', 'utterance', '{"text": "tenant-b の記憶 17 東京 会議 プロジェクト2 ZERO", "speaker": "user"}', NULL, '2026-09-30 16:10:28.544+09', NULL, NULL);
INSERT INTO public.observations VALUES ('f43f47cf-cd0c-401a-aa17-f34da5870c58', 'tenant-b', NULL, NULL, 'utterance', '{"text": "tenant-b FAIL 埋め込み失敗 東京", "speaker": "user"}', NULL, '2026-09-30 16:10:28.547+09', NULL, NULL);
INSERT INTO public.observations VALUES ('21dc8ea7-d9db-45ea-b661-8c717990146d', 'tenant-b', NULL, NULL, 'utterance', '{"text": "tenant-b 未埋め込み 0", "speaker": "user"}', NULL, '2026-09-30 16:10:28.6+09', NULL, NULL);
INSERT INTO public.observations VALUES ('31592c08-72fb-4b86-ba57-3277ebb273e4', 'tenant-b', NULL, NULL, 'utterance', '{"text": "tenant-b 未埋め込み 1", "speaker": "user"}', NULL, '2026-09-30 16:10:28.603+09', NULL, NULL);
INSERT INTO public.observations VALUES ('47928993-378d-4d18-a28a-d594a9e8a19e', 'tenant-b', NULL, NULL, 'utterance', '{"text": "tenant-b 未埋め込み 2", "speaker": "user"}', NULL, '2026-09-30 16:10:28.608+09', NULL, NULL);
INSERT INTO public.observations VALUES ('1af82fb1-8c84-4939-a45f-fd838297bc2f', 'tenant-b', NULL, NULL, 'usage', '{"recallId": "08c156fa-9d24-4d4f-8454-4108c48ba46f", "usedMemoryIds": ["e063c891-63b5-427c-9678-484e0cfec148"]}', NULL, '2026-09-30 16:10:28.626+09', NULL, NULL);
INSERT INTO public.observations VALUES ('897e33f9-7abb-4c13-ab9c-379816fc8531', 'tenant-c', NULL, 'tenant-c-ext-0', 'utterance', '{"text": "tenant-c の記憶 0 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-30 16:10:28.629+09', NULL, NULL);
INSERT INTO public.observations VALUES ('5d5df62e-7088-47c7-b444-425dce000eda', 'tenant-c', NULL, 'tenant-c-ext-1', 'utterance', '{"text": "tenant-c の記憶 1 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-30 16:10:28.632+09', NULL, NULL);
INSERT INTO public.observations VALUES ('404a82bf-e9c1-44fc-8cd9-cbff2c2fd200', 'tenant-c', NULL, 'tenant-c-ext-2', 'utterance', '{"text": "tenant-c の記憶 2 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-30 16:10:28.636+09', NULL, NULL);
INSERT INTO public.observations VALUES ('a7bf69ac-0b74-4a20-9480-4045f3eb604e', 'tenant-c', NULL, 'tenant-c-ext-3', 'utterance', '{"text": "tenant-c の記憶 3 東京 会議 プロジェクト3 ZERO", "speaker": "user"}', NULL, '2026-09-30 16:10:28.64+09', NULL, NULL);
INSERT INTO public.observations VALUES ('174d4196-adcf-4868-bdd6-586ba61c3689', 'tenant-c', NULL, 'tenant-c-ext-4', 'utterance', '{"text": "tenant-c の記憶 4 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-30 16:10:28.642+09', NULL, NULL);
INSERT INTO public.observations VALUES ('2308068d-6d20-4e72-bedb-82b33db53c40', 'tenant-c', NULL, 'tenant-c-ext-5', 'utterance', '{"text": "tenant-c の記憶 5 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-30 16:10:28.645+09', NULL, NULL);
INSERT INTO public.observations VALUES ('40c3d240-b305-4175-b58f-0eaa6e7bfdd5', 'tenant-c', NULL, 'tenant-c-ext-6', 'utterance', '{"text": "tenant-c の記憶 6 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-30 16:10:28.648+09', NULL, NULL);
INSERT INTO public.observations VALUES ('5261947b-df7f-4e75-b8d6-8a70cf1ddeb7', 'tenant-c', NULL, 'tenant-c-ext-7', 'utterance', '{"text": "tenant-c の記憶 7 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-30 16:10:28.651+09', NULL, NULL);
INSERT INTO public.observations VALUES ('3e624c0a-ba29-479a-bdd9-b8bbc21243a8', 'tenant-c', NULL, 'tenant-c-ext-8', 'utterance', '{"text": "tenant-c の記憶 8 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-30 16:10:28.654+09', NULL, NULL);
INSERT INTO public.observations VALUES ('cd9f3f9f-9d3f-474b-a5b8-1eceb426b359', 'tenant-c', NULL, 'tenant-c-ext-9', 'utterance', '{"text": "tenant-c の記憶 9 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-30 16:10:28.656+09', NULL, NULL);
INSERT INTO public.observations VALUES ('b5f667ea-af53-4af9-bd22-e547e9bdafe8', 'tenant-c', NULL, 'tenant-c-ext-10', 'utterance', '{"text": "tenant-c の記憶 10 東京 会議 プロジェクト0 ZERO", "speaker": "user"}', NULL, '2026-09-30 16:10:28.659+09', NULL, NULL);
INSERT INTO public.observations VALUES ('2aee3c82-20d1-468a-97bb-1939e439a832', 'tenant-c', NULL, 'tenant-c-ext-11', 'utterance', '{"text": "tenant-c の記憶 11 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-30 16:10:28.662+09', NULL, NULL);
INSERT INTO public.observations VALUES ('4b686057-0886-4b17-ba86-458597b54aef', 'tenant-c', NULL, NULL, 'utterance', '{"text": "tenant-c FAIL 埋め込み失敗 東京", "speaker": "user"}', NULL, '2026-09-30 16:10:28.664+09', NULL, NULL);
INSERT INTO public.observations VALUES ('fe42f01d-6aa4-4482-92de-2e34fcd3b584', 'tenant-c', NULL, NULL, 'utterance', '{"text": "tenant-c 未埋め込み 0", "speaker": "user"}', NULL, '2026-09-30 16:10:28.69+09', NULL, NULL);
INSERT INTO public.observations VALUES ('482310e0-72f1-429a-8470-7391cd2b0cd8', 'tenant-c', NULL, NULL, 'utterance', '{"text": "tenant-c 未埋め込み 1", "speaker": "user"}', NULL, '2026-09-30 16:10:28.694+09', NULL, NULL);
INSERT INTO public.observations VALUES ('cf6fa671-3757-444e-bb02-52e573c9817d', 'tenant-c', NULL, NULL, 'utterance', '{"text": "tenant-c 未埋め込み 2", "speaker": "user"}', NULL, '2026-09-30 16:10:28.697+09', NULL, NULL);
INSERT INTO public.observations VALUES ('1db988a8-798f-4a06-b35d-b906fca40c1b', 'tenant-c', NULL, NULL, 'usage', '{"recallId": "328f9e83-958f-4c5b-972b-5094a9828089", "usedMemoryIds": ["86537f40-a1c3-4777-a868-66f1622eb652"]}', NULL, '2026-09-30 16:10:28.713+09', NULL, NULL);
INSERT INTO public.observations VALUES ('00146ece-dfb1-4c18-b274-f804695477f6', 'tenant-a2', NULL, 'tenant-a2-ext-0', 'utterance', '{"text": "tenant-a2 の記憶 0 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-30 16:10:28.715+09', NULL, NULL);
INSERT INTO public.observations VALUES ('69c45eab-23b5-4545-b619-1ed91221a75b', 'tenant-a2', NULL, 'tenant-a2-ext-1', 'utterance', '{"text": "tenant-a2 の記憶 1 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-30 16:10:28.718+09', NULL, NULL);
INSERT INTO public.observations VALUES ('41504b63-b402-4ae1-9e79-abcb9e801955', 'tenant-a2', NULL, 'tenant-a2-ext-2', 'utterance', '{"text": "tenant-a2 の記憶 2 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-30 16:10:28.722+09', NULL, NULL);
INSERT INTO public.observations VALUES ('6551e295-d41c-4f47-add8-6b2d23df0308', 'tenant-a2', NULL, 'tenant-a2-ext-3', 'utterance', '{"text": "tenant-a2 の記憶 3 東京 会議 プロジェクト3 ZERO", "speaker": "user"}', NULL, '2026-09-30 16:10:28.725+09', NULL, NULL);
INSERT INTO public.observations VALUES ('57b3e37b-cb8a-49f7-bd53-7fbf8708af81', 'tenant-a2', NULL, 'tenant-a2-ext-4', 'utterance', '{"text": "tenant-a2 の記憶 4 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-30 16:10:28.728+09', NULL, NULL);
INSERT INTO public.observations VALUES ('0ccc9173-835d-4bdb-a545-91e437ba77e3', 'tenant-a2', NULL, 'tenant-a2-ext-5', 'utterance', '{"text": "tenant-a2 の記憶 5 東京 会議 プロジェクト0", "speaker": "user"}', NULL, '2026-09-30 16:10:28.731+09', NULL, NULL);
INSERT INTO public.observations VALUES ('8074c4a0-3534-41ff-99f7-f66ab0e918c0', 'tenant-a2', NULL, 'tenant-a2-ext-6', 'utterance', '{"text": "tenant-a2 の記憶 6 東京 会議 プロジェクト1", "speaker": "user"}', NULL, '2026-09-30 16:10:28.734+09', NULL, NULL);
INSERT INTO public.observations VALUES ('1f53fa34-341b-4866-a248-7690e5a509f5', 'tenant-a2', NULL, 'tenant-a2-ext-7', 'utterance', '{"text": "tenant-a2 の記憶 7 東京 会議 プロジェクト2", "speaker": "user"}', NULL, '2026-09-30 16:10:28.737+09', NULL, NULL);
INSERT INTO public.observations VALUES ('a560737a-6d4c-4753-852f-844bd132ae23', 'tenant-a2', NULL, 'tenant-a2-ext-8', 'utterance', '{"text": "tenant-a2 の記憶 8 東京 会議 プロジェクト3", "speaker": "user"}', NULL, '2026-09-30 16:10:28.74+09', NULL, NULL);
INSERT INTO public.observations VALUES ('50516e9d-2dba-4bf8-be6c-8489bdd7f2e1', 'tenant-a2', NULL, 'tenant-a2-ext-9', 'utterance', '{"text": "tenant-a2 の記憶 9 東京 会議 プロジェクト4", "speaker": "user"}', NULL, '2026-09-30 16:10:28.744+09', NULL, NULL);
INSERT INTO public.observations VALUES ('8f97f8b5-12b3-410f-b143-6eb05e4905da', 'tenant-a2', NULL, NULL, 'utterance', '{"text": "tenant-a2 FAIL 埋め込み失敗 東京", "speaker": "user"}', NULL, '2026-09-30 16:10:28.747+09', NULL, NULL);
INSERT INTO public.observations VALUES ('a0534cb7-ee9a-4aac-aa48-af5da5eb4572', 'tenant-a2', NULL, NULL, 'utterance', '{"text": "tenant-a2 未埋め込み 0", "speaker": "user"}', NULL, '2026-09-30 16:10:28.771+09', NULL, NULL);
INSERT INTO public.observations VALUES ('122bfe15-0289-4e27-85cd-f18a8aeba1c2', 'tenant-a2', NULL, NULL, 'utterance', '{"text": "tenant-a2 未埋め込み 1", "speaker": "user"}', NULL, '2026-09-30 16:10:28.774+09', NULL, NULL);
INSERT INTO public.observations VALUES ('143b2d68-cf0b-4510-9f37-64c91d0d6ee6', 'tenant-a2', NULL, NULL, 'utterance', '{"text": "tenant-a2 未埋め込み 2", "speaker": "user"}', NULL, '2026-09-30 16:10:28.797+09', NULL, NULL);
INSERT INTO public.observations VALUES ('049184e2-c85e-4eb4-a3b3-9b71807be54e', 'tenant-a2', NULL, NULL, 'usage', '{"recallId": "2d4cbb0c-65e2-4785-bfa4-b0f8db9dd135", "usedMemoryIds": ["4f45de75-e881-4856-8d05-aad412e744c3"]}', NULL, '2026-09-30 16:10:28.819+09', NULL, NULL);


--
-- Data for Name: outbox; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.outbox VALUES ('97568c66-b30c-4698-bd0b-29937893a2bb', 'tenant-a', 'extract', '{"observationId": "3170047c-439d-437b-80dd-f37d57c1609b"}', '2026-09-30 16:10:28.237089+09', NULL, NULL, 0, '2026-09-30 16:10:28.252625+09', NULL, NULL, '2026-09-30 16:10:28.237089+09');
INSERT INTO public.outbox VALUES ('6256faea-c56a-44eb-9fde-039c015630a2', 'tenant-a', 'extract', '{"observationId": "f99381d3-2ff9-42d8-b89c-cb65bd5555ab"}', '2026-09-30 16:10:28.253669+09', NULL, NULL, 0, '2026-09-30 16:10:28.258807+09', NULL, NULL, '2026-09-30 16:10:28.253669+09');
INSERT INTO public.outbox VALUES ('d03d181d-c8f5-4fb4-b46b-c73d94c6f97c', 'tenant-a', 'extract', '{"observationId": "d91ffdbc-7a8f-4d90-8533-7ac380bf84f5"}', '2026-09-30 16:10:28.259501+09', NULL, NULL, 0, '2026-09-30 16:10:28.263832+09', NULL, NULL, '2026-09-30 16:10:28.259501+09');
INSERT INTO public.outbox VALUES ('0b4a70f9-ae90-442c-87d0-377a411b2fdb', 'tenant-a', 'extract', '{"observationId": "7c50d0b1-82ce-4d1b-a658-b174282aa4e1"}', '2026-09-30 16:10:28.264551+09', NULL, NULL, 0, '2026-09-30 16:10:28.268804+09', NULL, NULL, '2026-09-30 16:10:28.264551+09');
INSERT INTO public.outbox VALUES ('5511d9f6-ef8d-4c66-8b78-a0d92871ae83', 'tenant-a', 'extract', '{"observationId": "e5f562cf-fe5b-491e-8cbc-6a6c6c3d208c"}', '2026-09-30 16:10:28.26937+09', NULL, NULL, 0, '2026-09-30 16:10:28.2743+09', NULL, NULL, '2026-09-30 16:10:28.26937+09');
INSERT INTO public.outbox VALUES ('218ec271-72da-4ea3-9bad-3eb6faea9470', 'tenant-a', 'extract', '{"observationId": "a46b840f-5880-4307-8d8c-6deda5af7cde"}', '2026-09-30 16:10:28.274998+09', NULL, NULL, 0, '2026-09-30 16:10:28.27868+09', NULL, NULL, '2026-09-30 16:10:28.274998+09');
INSERT INTO public.outbox VALUES ('6953bb35-d60e-4b00-b821-6e02d33a51b6', 'tenant-a', 'extract', '{"observationId": "8756c4a3-1be5-4269-9a40-8e7954d47b0c"}', '2026-09-30 16:10:28.279187+09', NULL, NULL, 0, '2026-09-30 16:10:28.285626+09', NULL, NULL, '2026-09-30 16:10:28.279187+09');
INSERT INTO public.outbox VALUES ('9160f368-b9b1-4e4d-90fe-1e25ff5acb94', 'tenant-a', 'extract', '{"observationId": "537fcfb1-864a-4d2d-a3a4-1bccc4cae503"}', '2026-09-30 16:10:28.286528+09', NULL, NULL, 0, '2026-09-30 16:10:28.291545+09', NULL, NULL, '2026-09-30 16:10:28.286528+09');
INSERT INTO public.outbox VALUES ('701a6004-efdb-4972-b2a9-90f2ff8b85e6', 'tenant-a', 'extract', '{"observationId": "ac48f49d-1570-40ff-a858-fd995fbbafa5"}', '2026-09-30 16:10:28.292145+09', NULL, NULL, 0, '2026-09-30 16:10:28.295924+09', NULL, NULL, '2026-09-30 16:10:28.292145+09');
INSERT INTO public.outbox VALUES ('7f070f51-18c2-43b5-bfba-55f77489c360', 'tenant-a', 'extract', '{"observationId": "1c44e415-8ff0-4944-9021-367f57dc6ded"}', '2026-09-30 16:10:28.296517+09', NULL, NULL, 0, '2026-09-30 16:10:28.300034+09', NULL, NULL, '2026-09-30 16:10:28.296517+09');
INSERT INTO public.outbox VALUES ('b0c79d68-7616-4633-ab36-e2c5bb13d07a', 'tenant-a', 'extract', '{"observationId": "c18fb4a4-06af-4366-b8fe-f8bad0522dcc"}', '2026-09-30 16:10:28.300527+09', NULL, NULL, 0, '2026-09-30 16:10:28.304635+09', NULL, NULL, '2026-09-30 16:10:28.300527+09');
INSERT INTO public.outbox VALUES ('336d048e-b379-4c2c-9c7d-e4cf1d8fad50', 'tenant-a', 'extract', '{"observationId": "ec2abc0b-10d4-4578-a585-71d85c50227f"}', '2026-09-30 16:10:28.305187+09', NULL, NULL, 0, '2026-09-30 16:10:28.308476+09', NULL, NULL, '2026-09-30 16:10:28.305187+09');
INSERT INTO public.outbox VALUES ('e607fb23-98d3-4a87-b139-b1efdc9f5640', 'tenant-a', 'extract', '{"observationId": "c3c2bdc0-9096-4579-b816-eba93a376bc1"}', '2026-09-30 16:10:28.308951+09', NULL, NULL, 0, '2026-09-30 16:10:28.312455+09', NULL, NULL, '2026-09-30 16:10:28.308951+09');
INSERT INTO public.outbox VALUES ('42dbc5f3-d8ac-4cf6-8303-4d287ac0cec6', 'tenant-a', 'extract', '{"observationId": "d50c9727-c674-4dcc-8c4b-0f2b7a52a38d"}', '2026-09-30 16:10:28.312961+09', NULL, NULL, 0, '2026-09-30 16:10:28.316104+09', NULL, NULL, '2026-09-30 16:10:28.312961+09');
INSERT INTO public.outbox VALUES ('0f8b5ede-79b4-41c2-82cf-0c8eb6ae4b74', 'tenant-a', 'extract', '{"observationId": "5c62a7cc-5ea8-4fe3-a984-d6a92e289dc3"}', '2026-09-30 16:10:28.316539+09', NULL, NULL, 0, '2026-09-30 16:10:28.319798+09', NULL, NULL, '2026-09-30 16:10:28.316539+09');
INSERT INTO public.outbox VALUES ('cc111de6-f432-4ab8-8426-789219c7a087', 'tenant-a', 'extract', '{"observationId": "0f9124f0-75e0-4f90-a837-964a8a73e741"}', '2026-09-30 16:10:28.320272+09', NULL, NULL, 0, '2026-09-30 16:10:28.323565+09', NULL, NULL, '2026-09-30 16:10:28.320272+09');
INSERT INTO public.outbox VALUES ('5257ec52-8c08-4d9a-af29-da3e879f71c0', 'tenant-a', 'extract', '{"observationId": "8fa787c0-15d5-45cd-a8ef-82614da0e289"}', '2026-09-30 16:10:28.324109+09', NULL, NULL, 0, '2026-09-30 16:10:28.329085+09', NULL, NULL, '2026-09-30 16:10:28.324109+09');
INSERT INTO public.outbox VALUES ('16ffc339-7f2c-4682-8199-eb2fa6886cb5', 'tenant-a', 'extract', '{"observationId": "664ba403-7c58-4a1c-baf6-0a57e1743de5"}', '2026-09-30 16:10:28.329668+09', NULL, NULL, 0, '2026-09-30 16:10:28.332658+09', NULL, NULL, '2026-09-30 16:10:28.329668+09');
INSERT INTO public.outbox VALUES ('d2ba6329-84da-4e43-ae24-c657d72d858e', 'tenant-a', 'extract', '{"observationId": "de056da7-0494-49d4-a6af-df0bb6457a04"}', '2026-09-30 16:10:28.333119+09', NULL, NULL, 0, '2026-09-30 16:10:28.336366+09', NULL, NULL, '2026-09-30 16:10:28.333119+09');
INSERT INTO public.outbox VALUES ('a1354d34-d8f1-4eb2-af13-21a8121df83f', 'tenant-a', 'extract', '{"observationId": "2a678390-3e9f-4a00-ad81-d9b9f96da5e4"}', '2026-09-30 16:10:28.339582+09', NULL, NULL, 0, '2026-09-30 16:10:28.343379+09', NULL, NULL, '2026-09-30 16:10:28.339582+09');
INSERT INTO public.outbox VALUES ('00ee4ba5-c20a-4f26-a12a-280b74f4d281', 'tenant-a', 'extract', '{"observationId": "85a364b0-30e9-4351-a444-0c65189167bc"}', '2026-09-30 16:10:28.343965+09', NULL, NULL, 0, '2026-09-30 16:10:28.34679+09', NULL, NULL, '2026-09-30 16:10:28.343965+09');
INSERT INTO public.outbox VALUES ('637a5deb-9ff0-48cb-8f54-fccbd9835725', 'tenant-a', 'extract', '{"observationId": "2533acb4-2f6e-476b-a555-e5cb3006169b"}', '2026-09-30 16:10:28.347192+09', NULL, NULL, 0, '2026-09-30 16:10:28.350465+09', NULL, NULL, '2026-09-30 16:10:28.347192+09');
INSERT INTO public.outbox VALUES ('4dcdadf7-d3d8-4557-9c73-fed7c0034e6e', 'tenant-a', 'extract', '{"observationId": "8c3dffc1-e5ff-4131-8377-a8c800508a4d"}', '2026-09-30 16:10:28.350925+09', NULL, NULL, 0, '2026-09-30 16:10:28.353766+09', NULL, NULL, '2026-09-30 16:10:28.350925+09');
INSERT INTO public.outbox VALUES ('44bdab4c-ffdd-4d52-a2d4-973ce56a9eae', 'tenant-a', 'extract', '{"observationId": "aef701a6-ee0b-4360-89bf-a2221fac242f"}', '2026-09-30 16:10:28.354216+09', NULL, NULL, 0, '2026-09-30 16:10:28.357101+09', NULL, NULL, '2026-09-30 16:10:28.354216+09');
INSERT INTO public.outbox VALUES ('904684f8-7af8-497e-9fcc-61b06c567205', 'tenant-a', 'extract', '{"observationId": "9576c6dd-dd9f-48d1-8d99-a19d430e838f"}', '2026-09-30 16:10:28.357591+09', NULL, NULL, 0, '2026-09-30 16:10:28.360642+09', NULL, NULL, '2026-09-30 16:10:28.357591+09');
INSERT INTO public.outbox VALUES ('964b4d5c-46eb-4986-bf6e-937e1d076c28', 'tenant-a', 'embed', '{"memoryId": "e9b4837a-7259-4c1f-ac42-623c40b65da8"}', '2026-09-30 16:10:28.244488+09', '2026-09-30 16:10:28.361+09', 'runtime.tick', 1, '2026-09-30 16:10:28.366436+09', NULL, NULL, '2026-09-30 16:10:28.244488+09');
INSERT INTO public.outbox VALUES ('29a5f091-d35a-4425-8fd2-cb0eeb242ec0', 'tenant-a', 'embed', '{"memoryId": "385ddb84-f30d-45b6-a610-a90f4fa542da"}', '2026-09-30 16:10:28.256191+09', '2026-09-30 16:10:28.361+09', 'runtime.tick', 1, '2026-09-30 16:10:28.369079+09', NULL, NULL, '2026-09-30 16:10:28.256191+09');
INSERT INTO public.outbox VALUES ('df4b77a1-9a96-4079-93b7-c4318c527507', 'tenant-a', 'embed', '{"memoryId": "cdaec7f7-e905-4944-bea0-efbd5313f206"}', '2026-09-30 16:10:28.261151+09', '2026-09-30 16:10:28.361+09', 'runtime.tick', 1, '2026-09-30 16:10:28.371315+09', NULL, NULL, '2026-09-30 16:10:28.261151+09');
INSERT INTO public.outbox VALUES ('6ec2a4e9-60ca-4cbb-b05f-8d5946caa22d', 'tenant-a', 'embed', '{"memoryId": "d6871336-2ab3-4100-81c0-1418236588ac"}', '2026-09-30 16:10:28.266486+09', '2026-09-30 16:10:28.361+09', 'runtime.tick', 1, '2026-09-30 16:10:28.373877+09', NULL, NULL, '2026-09-30 16:10:28.266486+09');
INSERT INTO public.outbox VALUES ('bb7583a3-2895-419d-b29e-776e2614f2d8', 'tenant-a', 'embed', '{"memoryId": "bdf590b6-cdf8-4f7f-9747-f274d8e039de"}', '2026-09-30 16:10:28.271229+09', '2026-09-30 16:10:28.361+09', 'runtime.tick', 1, '2026-09-30 16:10:28.378538+09', NULL, NULL, '2026-09-30 16:10:28.271229+09');
INSERT INTO public.outbox VALUES ('3c888812-24f9-47d5-9c77-3b298172556d', 'tenant-a', 'embed', '{"memoryId": "9f6e751a-d10d-4867-894c-3b3318fc5ad6"}', '2026-09-30 16:10:28.276724+09', '2026-09-30 16:10:28.361+09', 'runtime.tick', 1, '2026-09-30 16:10:28.381116+09', NULL, NULL, '2026-09-30 16:10:28.276724+09');
INSERT INTO public.outbox VALUES ('a0ecc83e-7b70-4a51-b656-1f6f885c1fd3', 'tenant-a', 'embed', '{"memoryId": "71959e35-ff92-4e32-a488-24ac50e52e23"}', '2026-09-30 16:10:28.283472+09', '2026-09-30 16:10:28.361+09', 'runtime.tick', 1, '2026-09-30 16:10:28.383692+09', NULL, NULL, '2026-09-30 16:10:28.283472+09');
INSERT INTO public.outbox VALUES ('dacb68d9-8d5f-4ee1-9662-4ea39a46dccf', 'tenant-a', 'embed', '{"memoryId": "6c000d76-3068-4f9a-b7f2-bf49c407604c"}', '2026-09-30 16:10:28.288591+09', '2026-09-30 16:10:28.361+09', 'runtime.tick', 1, '2026-09-30 16:10:28.386095+09', NULL, NULL, '2026-09-30 16:10:28.288591+09');
INSERT INTO public.outbox VALUES ('71b84904-cc28-4367-8952-2b9b3dc2e02c', 'tenant-a', 'embed', '{"memoryId": "db52e2d3-3a70-4031-b38b-99a212ee5ce5"}', '2026-09-30 16:10:28.293956+09', '2026-09-30 16:10:28.361+09', 'runtime.tick', 1, '2026-09-30 16:10:28.388444+09', NULL, NULL, '2026-09-30 16:10:28.293956+09');
INSERT INTO public.outbox VALUES ('f54f7925-1a0d-445c-bef2-13bbbba58ee5', 'tenant-a', 'embed', '{"memoryId": "b7a747ef-2733-4e8e-8e98-b8daaf0d1c49"}', '2026-09-30 16:10:28.298089+09', '2026-09-30 16:10:28.361+09', 'runtime.tick', 1, '2026-09-30 16:10:28.390685+09', NULL, NULL, '2026-09-30 16:10:28.298089+09');
INSERT INTO public.outbox VALUES ('941d3cf2-4d0d-4412-bb20-6f25ad8d283b', 'tenant-a', 'embed', '{"memoryId": "0254ee12-a693-40d1-97ab-6d11e591459a"}', '2026-09-30 16:10:28.302354+09', '2026-09-30 16:10:28.361+09', 'runtime.tick', 1, '2026-09-30 16:10:28.392703+09', NULL, NULL, '2026-09-30 16:10:28.302354+09');
INSERT INTO public.outbox VALUES ('f262014f-c4f4-43d5-a06a-f75365545ffa', 'tenant-a', 'embed', '{"memoryId": "b5bbe07f-7133-4192-ad0a-b7ce2d75dd27"}', '2026-09-30 16:10:28.306664+09', '2026-09-30 16:10:28.361+09', 'runtime.tick', 1, '2026-09-30 16:10:28.395083+09', NULL, NULL, '2026-09-30 16:10:28.306664+09');
INSERT INTO public.outbox VALUES ('cad70934-3337-4d96-bb05-90ad32fa1e04', 'tenant-a', 'embed', '{"memoryId": "f3153b73-6258-450f-ae4a-19807dbacb14"}', '2026-09-30 16:10:28.310527+09', '2026-09-30 16:10:28.361+09', 'runtime.tick', 1, '2026-09-30 16:10:28.39726+09', NULL, NULL, '2026-09-30 16:10:28.310527+09');
INSERT INTO public.outbox VALUES ('feb13f07-d2e1-4db0-92b2-eb474dd92d7f', 'tenant-a', 'embed', '{"memoryId": "0142288a-451a-4d56-99e8-31edb1a7d52a"}', '2026-09-30 16:10:28.314316+09', '2026-09-30 16:10:28.361+09', 'runtime.tick', 1, '2026-09-30 16:10:28.399385+09', NULL, NULL, '2026-09-30 16:10:28.314316+09');
INSERT INTO public.outbox VALUES ('bcdcc3c8-d9c4-4c43-82c7-a71f86b2017b', 'tenant-a', 'embed', '{"memoryId": "7a65904e-aa1f-4438-9fa2-702c1d6fb953"}', '2026-09-30 16:10:28.318056+09', '2026-09-30 16:10:28.361+09', 'runtime.tick', 1, '2026-09-30 16:10:28.401582+09', NULL, NULL, '2026-09-30 16:10:28.318056+09');
INSERT INTO public.outbox VALUES ('6b7910fa-6fef-4e57-8939-4e3af87f7409', 'tenant-a', 'embed', '{"memoryId": "75e7ec0d-7c97-455d-828a-7be812c96d5a"}', '2026-09-30 16:10:28.321614+09', '2026-09-30 16:10:28.361+09', 'runtime.tick', 1, '2026-09-30 16:10:28.403702+09', NULL, NULL, '2026-09-30 16:10:28.321614+09');
INSERT INTO public.outbox VALUES ('69cb2316-4f5e-42fc-b492-3d588f3e281f', 'tenant-a', 'embed', '{"memoryId": "2ad5f6f4-6af3-480a-963d-c2581e800298"}', '2026-09-30 16:10:28.327162+09', '2026-09-30 16:10:28.361+09', 'runtime.tick', 1, '2026-09-30 16:10:28.406242+09', NULL, NULL, '2026-09-30 16:10:28.327162+09');
INSERT INTO public.outbox VALUES ('33ade6ba-c81d-4afb-85a5-ac40973c6fd9', 'tenant-a', 'embed', '{"memoryId": "7f850fd5-b588-4e98-810e-61880d17f5dc"}', '2026-09-30 16:10:28.331004+09', '2026-09-30 16:10:28.361+09', 'runtime.tick', 1, '2026-09-30 16:10:28.409423+09', NULL, NULL, '2026-09-30 16:10:28.331004+09');
INSERT INTO public.outbox VALUES ('feee955b-b558-4b18-825d-ec72825d12d2', 'tenant-a', 'embed', '{"memoryId": "52352eb6-6c20-449b-bde9-92ceefad2119"}', '2026-09-30 16:10:28.334534+09', '2026-09-30 16:10:28.361+09', 'runtime.tick', 1, '2026-09-30 16:10:28.412406+09', NULL, NULL, '2026-09-30 16:10:28.334534+09');
INSERT INTO public.outbox VALUES ('c6c50f38-5bf8-4297-a6be-2df3a0e29f7f', 'tenant-a', 'embed', '{"memoryId": "790d7bb0-7be7-410d-a875-69d94b4bd0ff"}', '2026-09-30 16:10:28.341188+09', '2026-09-30 16:10:28.361+09', 'runtime.tick', 1, '2026-09-30 16:10:28.414944+09', NULL, NULL, '2026-09-30 16:10:28.341188+09');
INSERT INTO public.outbox VALUES ('dc5477d9-7830-4a23-aa20-15fb2a16a449', 'tenant-a', 'embed', '{"memoryId": "d21a2085-0e80-481f-8a1a-47d62e379080"}', '2026-09-30 16:10:28.345176+09', '2026-09-30 16:10:28.361+09', 'runtime.tick', 1, '2026-09-30 16:10:28.417552+09', NULL, NULL, '2026-09-30 16:10:28.345176+09');
INSERT INTO public.outbox VALUES ('74050cad-5f00-4883-adb4-d26a177010a6', 'tenant-a', 'embed', '{"memoryId": "5a7107e4-b415-4912-a260-b5ba85543982"}', '2026-09-30 16:10:28.348712+09', '2026-09-30 16:10:28.361+09', 'runtime.tick', 1, '2026-09-30 16:10:28.420065+09', NULL, NULL, '2026-09-30 16:10:28.348712+09');
INSERT INTO public.outbox VALUES ('f29b7488-17d5-467c-9b35-1c1eb9668335', 'tenant-a', 'embed', '{"memoryId": "decede7e-0883-47c7-a8e3-0333baa2b19c"}', '2026-09-30 16:10:28.352177+09', '2026-09-30 16:10:28.361+09', 'runtime.tick', 1, '2026-09-30 16:10:28.422848+09', NULL, NULL, '2026-09-30 16:10:28.352177+09');
INSERT INTO public.outbox VALUES ('c5ce4eff-0140-424f-98cc-00768a911df6', 'tenant-a', 'embed', '{"memoryId": "8f147a2c-4cb8-4320-a1b6-db425fdad60b"}', '2026-09-30 16:10:28.355644+09', '2026-09-30 16:10:28.361+09', 'runtime.tick', 1, '2026-09-30 16:10:28.425042+09', NULL, NULL, '2026-09-30 16:10:28.355644+09');
INSERT INTO public.outbox VALUES ('a0872170-47e2-4941-9323-cfa664443c6f', 'tenant-a', 'embed', '{"memoryId": "8688815a-d446-472b-beed-78717974d078"}', '2026-09-30 16:10:28.358837+09', '2026-09-30 16:10:28.361+09', 'runtime.tick', 1, NULL, '2026-09-30 16:10:28.427303+09', 'fixture: embedding provider failure', '2026-09-30 16:10:28.358837+09');
INSERT INTO public.outbox VALUES ('0fc21fc6-1587-4ff6-b943-ad033cfcd7b5', 'tenant-a', 'embed', '{"memoryId": "fd3d3f38-8d19-4f69-bc0c-bde37829b600"}', '2026-09-30 16:10:28.429568+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-30 16:10:28.429568+09');
INSERT INTO public.outbox VALUES ('21dde4e6-9c9f-47cd-9323-a5b55ff14c6a', 'tenant-a', 'extract', '{"observationId": "e7630a70-a4a2-496e-ad49-2fbe7fa6422f"}', '2026-09-30 16:10:28.427892+09', NULL, NULL, 0, '2026-09-30 16:10:28.431546+09', NULL, NULL, '2026-09-30 16:10:28.427892+09');
INSERT INTO public.outbox VALUES ('c6bde1c9-d579-452f-a470-6efad464eb53', 'tenant-a', 'embed', '{"memoryId": "19e371cd-0bc5-4a2e-bdd3-926c3e06a039"}', '2026-09-30 16:10:28.433679+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-30 16:10:28.433679+09');
INSERT INTO public.outbox VALUES ('ce08f957-8929-48f6-b7a1-86518fb0dff9', 'tenant-a', 'extract', '{"observationId": "3892bb50-d13f-49a3-9f5b-9bccc4ec8aab"}', '2026-09-30 16:10:28.432079+09', NULL, NULL, 0, '2026-09-30 16:10:28.435767+09', NULL, NULL, '2026-09-30 16:10:28.432079+09');
INSERT INTO public.outbox VALUES ('557600f4-1e96-400c-a7b0-0946dad8ed32', 'tenant-a', 'embed', '{"memoryId": "a473bc10-58af-4d43-a483-98ae7237f4cd"}', '2026-09-30 16:10:28.441888+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-30 16:10:28.441888+09');
INSERT INTO public.outbox VALUES ('bc177c65-765f-4dd2-ab44-8673f220adce', 'tenant-a', 'extract', '{"observationId": "9226deb4-9efe-4dd5-b839-41b0e73223e8"}', '2026-09-30 16:10:28.436353+09', NULL, NULL, 0, '2026-09-30 16:10:28.444893+09', NULL, NULL, '2026-09-30 16:10:28.436353+09');
INSERT INTO public.outbox VALUES ('05d5b121-0601-48ab-8b97-497d1ce9948a', 'tenant-b', 'extract', '{"observationId": "52476b9e-6649-4fb3-a330-3a955c0a4ae3"}', '2026-09-30 16:10:28.477398+09', NULL, NULL, 0, '2026-09-30 16:10:28.481353+09', NULL, NULL, '2026-09-30 16:10:28.477398+09');
INSERT INTO public.outbox VALUES ('65772d19-54aa-4362-a07f-32589f7a77bf', 'tenant-b', 'extract', '{"observationId": "798a8f2c-2e86-42f3-97e1-40d12069a4ab"}', '2026-09-30 16:10:28.48189+09', NULL, NULL, 0, '2026-09-30 16:10:28.485335+09', NULL, NULL, '2026-09-30 16:10:28.48189+09');
INSERT INTO public.outbox VALUES ('50e613a6-6879-4a8f-9a0d-8aa52e97f647', 'tenant-b', 'extract', '{"observationId": "fcae1158-de44-475b-bbe4-2ad40dad448a"}', '2026-09-30 16:10:28.485819+09', NULL, NULL, 0, '2026-09-30 16:10:28.488943+09', NULL, NULL, '2026-09-30 16:10:28.485819+09');
INSERT INTO public.outbox VALUES ('165826e4-4310-4f18-8695-24fc5ea42523', 'tenant-b', 'extract', '{"observationId": "8632e4e1-89ec-4179-812f-afe323083eea"}', '2026-09-30 16:10:28.489384+09', NULL, NULL, 0, '2026-09-30 16:10:28.493003+09', NULL, NULL, '2026-09-30 16:10:28.489384+09');
INSERT INTO public.outbox VALUES ('e43bb6ed-c540-4b71-9ae0-90b891d9c8ab', 'tenant-b', 'extract', '{"observationId": "026eb916-b6c1-4e5a-be18-172f4bc6730a"}', '2026-09-30 16:10:28.493541+09', NULL, NULL, 0, '2026-09-30 16:10:28.496902+09', NULL, NULL, '2026-09-30 16:10:28.493541+09');
INSERT INTO public.outbox VALUES ('afaa36ac-8e5f-46ee-a4f2-dc2951b7a6bb', 'tenant-b', 'extract', '{"observationId": "33eb90de-ce69-42c0-860c-27f0c484da6f"}', '2026-09-30 16:10:28.497421+09', NULL, NULL, 0, '2026-09-30 16:10:28.50095+09', NULL, NULL, '2026-09-30 16:10:28.497421+09');
INSERT INTO public.outbox VALUES ('a27b36e9-b133-485d-a911-96e75576c496', 'tenant-b', 'extract', '{"observationId": "69100d7a-9aed-4d47-a4ec-2b62dab54515"}', '2026-09-30 16:10:28.501463+09', NULL, NULL, 0, '2026-09-30 16:10:28.504627+09', NULL, NULL, '2026-09-30 16:10:28.501463+09');
INSERT INTO public.outbox VALUES ('249ffe5c-a9bc-4f99-95b3-604e259db238', 'tenant-b', 'extract', '{"observationId": "3b8f0f8b-1255-4153-a26e-79ab9314be25"}', '2026-09-30 16:10:28.505079+09', NULL, NULL, 0, '2026-09-30 16:10:28.508237+09', NULL, NULL, '2026-09-30 16:10:28.505079+09');
INSERT INTO public.outbox VALUES ('e970c0aa-2055-4f36-ac95-643d772396f1', 'tenant-b', 'embed', '{"memoryId": "602d957e-cff9-425f-b386-8565c7af9783"}', '2026-09-30 16:10:28.479322+09', '2026-09-30 16:10:28.551+09', 'runtime.tick', 1, '2026-09-30 16:10:28.554862+09', NULL, NULL, '2026-09-30 16:10:28.479322+09');
INSERT INTO public.outbox VALUES ('4ed4a4a5-4578-42ec-aceb-7e5b202e973c', 'tenant-b', 'extract', '{"observationId": "3c85995e-851b-40b3-8cc6-b9a03bd79856"}', '2026-09-30 16:10:28.508794+09', NULL, NULL, 0, '2026-09-30 16:10:28.511892+09', NULL, NULL, '2026-09-30 16:10:28.508794+09');
INSERT INTO public.outbox VALUES ('c4e0a46f-4d2f-4ee3-888c-5885754ee2c6', 'tenant-b', 'extract', '{"observationId": "c1a4bde9-7e9c-41ea-a82f-4aec9a396fe8"}', '2026-09-30 16:10:28.512432+09', NULL, NULL, 0, '2026-09-30 16:10:28.51559+09', NULL, NULL, '2026-09-30 16:10:28.512432+09');
INSERT INTO public.outbox VALUES ('1a13d5f8-6b56-403c-ae3d-df7dd7695f62', 'tenant-b', 'extract', '{"observationId": "17fcbc7c-d5a2-4720-beed-f0f30c710c55"}', '2026-09-30 16:10:28.516112+09', NULL, NULL, 0, '2026-09-30 16:10:28.520625+09', NULL, NULL, '2026-09-30 16:10:28.516112+09');
INSERT INTO public.outbox VALUES ('04e40000-7d49-4d75-a502-7395ff1f831e', 'tenant-b', 'extract', '{"observationId": "1177f4a6-6f2f-46b8-bf1b-5f0753770719"}', '2026-09-30 16:10:28.521146+09', NULL, NULL, 0, '2026-09-30 16:10:28.525076+09', NULL, NULL, '2026-09-30 16:10:28.521146+09');
INSERT INTO public.outbox VALUES ('17eb0cbb-e47a-4e06-8da1-603bef6a8e14', 'tenant-b', 'extract', '{"observationId": "af48aad9-78f1-4698-8d50-51e6acb5d770"}', '2026-09-30 16:10:28.525714+09', NULL, NULL, 0, '2026-09-30 16:10:28.529158+09', NULL, NULL, '2026-09-30 16:10:28.525714+09');
INSERT INTO public.outbox VALUES ('b6f2b627-4386-4c3c-8c5d-5aa646622418', 'tenant-b', 'extract', '{"observationId": "1d9b8833-240b-4111-a2ec-c2909189414e"}', '2026-09-30 16:10:28.529771+09', NULL, NULL, 0, '2026-09-30 16:10:28.533207+09', NULL, NULL, '2026-09-30 16:10:28.529771+09');
INSERT INTO public.outbox VALUES ('11690f10-c1bd-4213-bc86-f5937e8dfe0c', 'tenant-b', 'extract', '{"observationId": "70350c04-99e7-44c6-993c-dc5f8fc83b40"}', '2026-09-30 16:10:28.533815+09', NULL, NULL, 0, '2026-09-30 16:10:28.537086+09', NULL, NULL, '2026-09-30 16:10:28.533815+09');
INSERT INTO public.outbox VALUES ('9cac0b09-6112-4447-940f-fade5031e406', 'tenant-b', 'extract', '{"observationId": "841735b6-59d7-47c6-a884-c255db80e9f9"}', '2026-09-30 16:10:28.537545+09', NULL, NULL, 0, '2026-09-30 16:10:28.540463+09', NULL, NULL, '2026-09-30 16:10:28.537545+09');
INSERT INTO public.outbox VALUES ('60e26e41-e7ba-4f35-b514-d1db83acd7ba', 'tenant-b', 'extract', '{"observationId": "17885792-b3d3-46e3-9351-4081ac0990e4"}', '2026-09-30 16:10:28.54101+09', NULL, NULL, 0, '2026-09-30 16:10:28.54385+09', NULL, NULL, '2026-09-30 16:10:28.54101+09');
INSERT INTO public.outbox VALUES ('ca9e367f-c892-46b4-869b-b15ddc200a0e', 'tenant-b', 'extract', '{"observationId": "d51c6fcb-ee2d-4ba9-8409-fb31ac5b49c4"}', '2026-09-30 16:10:28.544276+09', NULL, NULL, 0, '2026-09-30 16:10:28.547088+09', NULL, NULL, '2026-09-30 16:10:28.544276+09');
INSERT INTO public.outbox VALUES ('c7e044c2-62ab-4083-a0f1-fc6a08807557', 'tenant-b', 'extract', '{"observationId": "f43f47cf-cd0c-401a-aa17-f34da5870c58"}', '2026-09-30 16:10:28.547555+09', NULL, NULL, 0, '2026-09-30 16:10:28.551167+09', NULL, NULL, '2026-09-30 16:10:28.547555+09');
INSERT INTO public.outbox VALUES ('466fdc8b-b884-49a7-b878-5ff2544e2238', 'tenant-b', 'embed', '{"memoryId": "98523396-eb33-468d-adbe-fd392d2bbb55"}', '2026-09-30 16:10:28.483317+09', '2026-09-30 16:10:28.551+09', 'runtime.tick', 1, '2026-09-30 16:10:28.556679+09', NULL, NULL, '2026-09-30 16:10:28.483317+09');
INSERT INTO public.outbox VALUES ('ebc7427c-46ab-4804-92af-842bc807dc17', 'tenant-b', 'embed', '{"memoryId": "9d84c4ff-7580-46dd-a1f4-25701838f3a3"}', '2026-09-30 16:10:28.487209+09', '2026-09-30 16:10:28.551+09', 'runtime.tick', 1, '2026-09-30 16:10:28.558789+09', NULL, NULL, '2026-09-30 16:10:28.487209+09');
INSERT INTO public.outbox VALUES ('be9d9686-b747-4f42-b29c-e33ad036d963', 'tenant-b', 'embed', '{"memoryId": "a8bdd009-902e-4d8e-aa86-46533de82784"}', '2026-09-30 16:10:28.490856+09', '2026-09-30 16:10:28.551+09', 'runtime.tick', 1, '2026-09-30 16:10:28.560754+09', NULL, NULL, '2026-09-30 16:10:28.490856+09');
INSERT INTO public.outbox VALUES ('99a2a88b-bda8-44f2-a74b-ee9bb63170d1', 'tenant-b', 'embed', '{"memoryId": "940d5ae2-af46-4c68-8032-e2913994003f"}', '2026-09-30 16:10:28.495034+09', '2026-09-30 16:10:28.551+09', 'runtime.tick', 1, '2026-09-30 16:10:28.562654+09', NULL, NULL, '2026-09-30 16:10:28.495034+09');
INSERT INTO public.outbox VALUES ('0a84d36a-a6d2-4f07-9c33-a65808d9e0c0', 'tenant-b', 'embed', '{"memoryId": "a7b25522-dfdd-472c-b6d7-94186b139d05"}', '2026-09-30 16:10:28.499026+09', '2026-09-30 16:10:28.551+09', 'runtime.tick', 1, '2026-09-30 16:10:28.564414+09', NULL, NULL, '2026-09-30 16:10:28.499026+09');
INSERT INTO public.outbox VALUES ('215c2e37-c70f-4c8e-a84f-9660fb4b55a2', 'tenant-b', 'embed', '{"memoryId": "30d58bb2-fc98-4a76-ad29-9ce67eaab64c"}', '2026-09-30 16:10:28.502902+09', '2026-09-30 16:10:28.551+09', 'runtime.tick', 1, '2026-09-30 16:10:28.566063+09', NULL, NULL, '2026-09-30 16:10:28.502902+09');
INSERT INTO public.outbox VALUES ('ebd3a03d-6c3e-4b03-b36d-8d48ff75109e', 'tenant-b', 'embed', '{"memoryId": "af28ef0f-9e57-4941-a5d7-100fb2d99d1c"}', '2026-09-30 16:10:28.506502+09', '2026-09-30 16:10:28.551+09', 'runtime.tick', 1, '2026-09-30 16:10:28.568113+09', NULL, NULL, '2026-09-30 16:10:28.506502+09');
INSERT INTO public.outbox VALUES ('6cccdb5b-6f02-4164-b2ba-1b1adb1c4170', 'tenant-b', 'embed', '{"memoryId": "7b425243-9d71-4795-9cff-6ed41ca62635"}', '2026-09-30 16:10:28.510179+09', '2026-09-30 16:10:28.551+09', 'runtime.tick', 1, '2026-09-30 16:10:28.569822+09', NULL, NULL, '2026-09-30 16:10:28.510179+09');
INSERT INTO public.outbox VALUES ('2935d4e8-d350-4b43-b3f7-a8d4f64d8c4f', 'tenant-b', 'embed', '{"memoryId": "d9097e76-d0e1-4463-b9c3-32da098ab361"}', '2026-09-30 16:10:28.513748+09', '2026-09-30 16:10:28.551+09', 'runtime.tick', 1, '2026-09-30 16:10:28.571438+09', NULL, NULL, '2026-09-30 16:10:28.513748+09');
INSERT INTO public.outbox VALUES ('f5a8cbd2-738d-4819-b029-af6ba12dc2b1', 'tenant-b', 'embed', '{"memoryId": "1c0582e1-781b-43de-875c-39424f4a606c"}', '2026-09-30 16:10:28.517874+09', '2026-09-30 16:10:28.551+09', 'runtime.tick', 1, '2026-09-30 16:10:28.57303+09', NULL, NULL, '2026-09-30 16:10:28.517874+09');
INSERT INTO public.outbox VALUES ('5c3df9aa-6915-4ba8-bad0-fda04c549cb7', 'tenant-b', 'embed', '{"memoryId": "34e46d3e-27d1-49bd-ac5e-00b8303fbb1c"}', '2026-09-30 16:10:28.522683+09', '2026-09-30 16:10:28.551+09', 'runtime.tick', 1, '2026-09-30 16:10:28.574707+09', NULL, NULL, '2026-09-30 16:10:28.522683+09');
INSERT INTO public.outbox VALUES ('6c389b4c-234e-4274-b682-4b4e02fad99d', 'tenant-b', 'embed', '{"memoryId": "8827e601-7f09-43cf-beb7-51fb0a6ca239"}', '2026-09-30 16:10:28.52717+09', '2026-09-30 16:10:28.551+09', 'runtime.tick', 1, '2026-09-30 16:10:28.583416+09', NULL, NULL, '2026-09-30 16:10:28.52717+09');
INSERT INTO public.outbox VALUES ('e0676beb-7d5d-4ba5-bc92-196d2a4801f7', 'tenant-b', 'embed', '{"memoryId": "3805ce1a-03ae-4ee7-9ffb-3dbab94f05e1"}', '2026-09-30 16:10:28.531255+09', '2026-09-30 16:10:28.551+09', 'runtime.tick', 1, '2026-09-30 16:10:28.58997+09', NULL, NULL, '2026-09-30 16:10:28.531255+09');
INSERT INTO public.outbox VALUES ('61d35824-6a70-4e48-9ee0-af928933b0a1', 'tenant-b', 'embed', '{"memoryId": "e063c891-63b5-427c-9678-484e0cfec148"}', '2026-09-30 16:10:28.535522+09', '2026-09-30 16:10:28.551+09', 'runtime.tick', 1, '2026-09-30 16:10:28.591951+09', NULL, NULL, '2026-09-30 16:10:28.535522+09');
INSERT INTO public.outbox VALUES ('17eb0184-365a-4f7a-825e-d6be9f8eb44b', 'tenant-b', 'embed', '{"memoryId": "0ad4b72a-6e8a-47f5-a17b-5a15e8480e25"}', '2026-09-30 16:10:28.538725+09', '2026-09-30 16:10:28.551+09', 'runtime.tick', 1, '2026-09-30 16:10:28.593968+09', NULL, NULL, '2026-09-30 16:10:28.538725+09');
INSERT INTO public.outbox VALUES ('4693ef84-dbdf-4dbf-b80e-4e162e94fb89', 'tenant-b', 'embed', '{"memoryId": "f2ab6369-c531-4f9f-89d1-93c0ec5b6967"}', '2026-09-30 16:10:28.542155+09', '2026-09-30 16:10:28.551+09', 'runtime.tick', 1, '2026-09-30 16:10:28.595952+09', NULL, NULL, '2026-09-30 16:10:28.542155+09');
INSERT INTO public.outbox VALUES ('5b327f09-6b10-42ce-baa5-0e3f4d1014d7', 'tenant-b', 'embed', '{"memoryId": "b6b09149-9e0a-44ea-8d8e-5e398a2b28c2"}', '2026-09-30 16:10:28.545298+09', '2026-09-30 16:10:28.551+09', 'runtime.tick', 1, '2026-09-30 16:10:28.597803+09', NULL, NULL, '2026-09-30 16:10:28.545298+09');
INSERT INTO public.outbox VALUES ('cd73e286-082c-4246-9e82-cc237ce3e3b9', 'tenant-b', 'embed', '{"memoryId": "464f2fd3-d8aa-4282-a8e2-81c77162e584"}', '2026-09-30 16:10:28.549027+09', '2026-09-30 16:10:28.551+09', 'runtime.tick', 1, NULL, '2026-09-30 16:10:28.599564+09', 'fixture: embedding provider failure', '2026-09-30 16:10:28.549027+09');
INSERT INTO public.outbox VALUES ('5136da85-9234-454c-95e2-08e84c28f183', 'tenant-b', 'embed', '{"memoryId": "6b031499-48ac-43ea-809f-9e706588e681"}', '2026-09-30 16:10:28.601711+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-30 16:10:28.601711+09');
INSERT INTO public.outbox VALUES ('dadb301b-43c0-4e81-93a5-82b35bc18e24', 'tenant-b', 'extract', '{"observationId": "21dc8ea7-d9db-45ea-b661-8c717990146d"}', '2026-09-30 16:10:28.600143+09', NULL, NULL, 0, '2026-09-30 16:10:28.603466+09', NULL, NULL, '2026-09-30 16:10:28.600143+09');
INSERT INTO public.outbox VALUES ('b72d75f5-9f0f-47e5-b47a-5e9d3fe40c95', 'tenant-b', 'embed', '{"memoryId": "f4732ff5-ac81-4824-8b4c-b4fab0e0ccec"}', '2026-09-30 16:10:28.606607+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-30 16:10:28.606607+09');
INSERT INTO public.outbox VALUES ('70f9fdab-216f-4e0a-abb1-b2cf82ff8e5c', 'tenant-b', 'extract', '{"observationId": "31592c08-72fb-4b86-ba57-3277ebb273e4"}', '2026-09-30 16:10:28.604135+09', NULL, NULL, 0, '2026-09-30 16:10:28.60847+09', NULL, NULL, '2026-09-30 16:10:28.604135+09');
INSERT INTO public.outbox VALUES ('c7605da1-b755-4cd4-9710-452e7c849428', 'tenant-b', 'embed', '{"memoryId": "3d8b7a59-9446-4c53-9ae9-c289e288ca6f"}', '2026-09-30 16:10:28.610106+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-30 16:10:28.610106+09');
INSERT INTO public.outbox VALUES ('7d4c9b05-42ac-47d0-9b89-3275a56ef501', 'tenant-b', 'extract', '{"observationId": "47928993-378d-4d18-a28a-d594a9e8a19e"}', '2026-09-30 16:10:28.608919+09', NULL, NULL, 0, '2026-09-30 16:10:28.611691+09', NULL, NULL, '2026-09-30 16:10:28.608919+09');
INSERT INTO public.outbox VALUES ('a673615d-a09e-4bf2-b16f-79193842357a', 'tenant-c', 'extract', '{"observationId": "897e33f9-7abb-4c13-ab9c-379816fc8531"}', '2026-09-30 16:10:28.629394+09', NULL, NULL, 0, '2026-09-30 16:10:28.632251+09', NULL, NULL, '2026-09-30 16:10:28.629394+09');
INSERT INTO public.outbox VALUES ('e71c590a-e3e5-45ab-891a-0de7cd78d71f', 'tenant-c', 'extract', '{"observationId": "5d5df62e-7088-47c7-b444-425dce000eda"}', '2026-09-30 16:10:28.63274+09', NULL, NULL, 0, '2026-09-30 16:10:28.635758+09', NULL, NULL, '2026-09-30 16:10:28.63274+09');
INSERT INTO public.outbox VALUES ('ae950aa8-e0ed-4837-81c2-8695293ae9ae', 'tenant-c', 'extract', '{"observationId": "404a82bf-e9c1-44fc-8cd9-cbff2c2fd200"}', '2026-09-30 16:10:28.636265+09', NULL, NULL, 0, '2026-09-30 16:10:28.639745+09', NULL, NULL, '2026-09-30 16:10:28.636265+09');
INSERT INTO public.outbox VALUES ('87540032-c497-4320-9294-924a0ab69230', 'tenant-c', 'extract', '{"observationId": "a7bf69ac-0b74-4a20-9480-4045f3eb604e"}', '2026-09-30 16:10:28.640139+09', NULL, NULL, 0, '2026-09-30 16:10:28.64233+09', NULL, NULL, '2026-09-30 16:10:28.640139+09');
INSERT INTO public.outbox VALUES ('ad652a7d-02eb-4fc1-bfca-51a5878a303e', 'tenant-c', 'extract', '{"observationId": "174d4196-adcf-4868-bdd6-586ba61c3689"}', '2026-09-30 16:10:28.642722+09', NULL, NULL, 0, '2026-09-30 16:10:28.644959+09', NULL, NULL, '2026-09-30 16:10:28.642722+09');
INSERT INTO public.outbox VALUES ('338d2642-b7eb-44b8-b8ec-37d4a8ba8fd7', 'tenant-c', 'extract', '{"observationId": "2308068d-6d20-4e72-bedb-82b33db53c40"}', '2026-09-30 16:10:28.645361+09', NULL, NULL, 0, '2026-09-30 16:10:28.647985+09', NULL, NULL, '2026-09-30 16:10:28.645361+09');
INSERT INTO public.outbox VALUES ('14d299a8-2222-4a1d-b053-3a19cf74e93a', 'tenant-c', 'extract', '{"observationId": "40c3d240-b305-4175-b58f-0eaa6e7bfdd5"}', '2026-09-30 16:10:28.648353+09', NULL, NULL, 0, '2026-09-30 16:10:28.651199+09', NULL, NULL, '2026-09-30 16:10:28.648353+09');
INSERT INTO public.outbox VALUES ('2f2fd208-08bf-476c-910c-a1e14a25f72c', 'tenant-c', 'extract', '{"observationId": "5261947b-df7f-4e75-b8d6-8a70cf1ddeb7"}', '2026-09-30 16:10:28.651575+09', NULL, NULL, 0, '2026-09-30 16:10:28.653921+09', NULL, NULL, '2026-09-30 16:10:28.651575+09');
INSERT INTO public.outbox VALUES ('e21debce-7c08-47d4-b430-a0dc07996f01', 'tenant-c', 'extract', '{"observationId": "3e624c0a-ba29-479a-bdd9-b8bbc21243a8"}', '2026-09-30 16:10:28.654325+09', NULL, NULL, 0, '2026-09-30 16:10:28.656541+09', NULL, NULL, '2026-09-30 16:10:28.654325+09');
INSERT INTO public.outbox VALUES ('a0d2da82-bad2-47ce-8860-012ed53f0e78', 'tenant-c', 'extract', '{"observationId": "cd9f3f9f-9d3f-474b-a5b8-1eceb426b359"}', '2026-09-30 16:10:28.65689+09', NULL, NULL, 0, '2026-09-30 16:10:28.659185+09', NULL, NULL, '2026-09-30 16:10:28.65689+09');
INSERT INTO public.outbox VALUES ('7c721926-3c1a-4692-90e5-1fc7b7aeb2e3', 'tenant-c', 'extract', '{"observationId": "b5f667ea-af53-4af9-bd22-e547e9bdafe8"}', '2026-09-30 16:10:28.659578+09', NULL, NULL, 0, '2026-09-30 16:10:28.661703+09', NULL, NULL, '2026-09-30 16:10:28.659578+09');
INSERT INTO public.outbox VALUES ('e310cf42-0ecb-44c2-be39-c53a9299ad4e', 'tenant-c', 'extract', '{"observationId": "2aee3c82-20d1-468a-97bb-1939e439a832"}', '2026-09-30 16:10:28.66206+09', NULL, NULL, 0, '2026-09-30 16:10:28.664188+09', NULL, NULL, '2026-09-30 16:10:28.66206+09');
INSERT INTO public.outbox VALUES ('368f8cab-9753-4ad4-96c0-1dce7362a419', 'tenant-c', 'extract', '{"observationId": "4b686057-0886-4b17-ba86-458597b54aef"}', '2026-09-30 16:10:28.664532+09', NULL, NULL, 0, '2026-09-30 16:10:28.666576+09', NULL, NULL, '2026-09-30 16:10:28.664532+09');
INSERT INTO public.outbox VALUES ('2bfb4a30-14ec-48f4-be8a-cc92ca00c6b1', 'tenant-c', 'embed', '{"memoryId": "67a19942-fd02-4e21-b29c-fe6c3235e52e"}', '2026-09-30 16:10:28.63071+09', '2026-09-30 16:10:28.666+09', 'runtime.tick', 1, '2026-09-30 16:10:28.669302+09', NULL, NULL, '2026-09-30 16:10:28.63071+09');
INSERT INTO public.outbox VALUES ('0993c331-45a2-4884-b500-431a10f0efb0', 'tenant-c', 'embed', '{"memoryId": "bcd20266-65d9-4d90-b8fe-4eee19f5d0b7"}', '2026-09-30 16:10:28.634076+09', '2026-09-30 16:10:28.666+09', 'runtime.tick', 1, '2026-09-30 16:10:28.670919+09', NULL, NULL, '2026-09-30 16:10:28.634076+09');
INSERT INTO public.outbox VALUES ('12c7daa2-5c10-4928-9502-3fbc064d0a20', 'tenant-c', 'embed', '{"memoryId": "86537f40-a1c3-4777-a868-66f1622eb652"}', '2026-09-30 16:10:28.637278+09', '2026-09-30 16:10:28.666+09', 'runtime.tick', 1, '2026-09-30 16:10:28.672706+09', NULL, NULL, '2026-09-30 16:10:28.637278+09');
INSERT INTO public.outbox VALUES ('e70123b7-c9a4-4e82-9f17-c7d32c9f2d21', 'tenant-c', 'embed', '{"memoryId": "e7dc9134-bf43-46b6-ad48-1530fadfddff"}', '2026-09-30 16:10:28.641069+09', '2026-09-30 16:10:28.666+09', 'runtime.tick', 1, '2026-09-30 16:10:28.674286+09', NULL, NULL, '2026-09-30 16:10:28.641069+09');
INSERT INTO public.outbox VALUES ('56ba00fd-44f6-4cb0-bc69-cf9cdcfeb999', 'tenant-c', 'embed', '{"memoryId": "957b1f8d-0583-4845-91c4-c1dc47b5e4b1"}', '2026-09-30 16:10:28.643732+09', '2026-09-30 16:10:28.666+09', 'runtime.tick', 1, '2026-09-30 16:10:28.675829+09', NULL, NULL, '2026-09-30 16:10:28.643732+09');
INSERT INTO public.outbox VALUES ('d6ab234d-3b05-4b2f-8e78-59487d5e3a2d', 'tenant-c', 'embed', '{"memoryId": "9a51add5-7e2b-401b-abcd-1c425efaab64"}', '2026-09-30 16:10:28.646621+09', '2026-09-30 16:10:28.666+09', 'runtime.tick', 1, '2026-09-30 16:10:28.677733+09', NULL, NULL, '2026-09-30 16:10:28.646621+09');
INSERT INTO public.outbox VALUES ('e0aac928-2d50-4239-bca6-b42b5d1af8e5', 'tenant-c', 'embed', '{"memoryId": "69eca64a-eb31-45e3-8ac8-d79a5590b8da"}', '2026-09-30 16:10:28.649811+09', '2026-09-30 16:10:28.666+09', 'runtime.tick', 1, '2026-09-30 16:10:28.679574+09', NULL, NULL, '2026-09-30 16:10:28.649811+09');
INSERT INTO public.outbox VALUES ('43845abe-edfa-451c-b7e4-ef1bd88b61e3', 'tenant-c', 'embed', '{"memoryId": "a5d1f82f-80cd-4f39-8067-47e16e0e8f6f"}', '2026-09-30 16:10:28.652527+09', '2026-09-30 16:10:28.666+09', 'runtime.tick', 1, '2026-09-30 16:10:28.681171+09', NULL, NULL, '2026-09-30 16:10:28.652527+09');
INSERT INTO public.outbox VALUES ('7a558f6e-409c-4c33-98b9-0865919ad4c2', 'tenant-c', 'embed', '{"memoryId": "91ce637e-a3a0-4936-909c-2c31d8d5b039"}', '2026-09-30 16:10:28.655308+09', '2026-09-30 16:10:28.666+09', 'runtime.tick', 1, '2026-09-30 16:10:28.682958+09', NULL, NULL, '2026-09-30 16:10:28.655308+09');
INSERT INTO public.outbox VALUES ('131e563c-8e60-4ac4-83d0-2e3d6900c0b2', 'tenant-c', 'embed', '{"memoryId": "6aa8e0ff-f2b5-40ed-9c6e-abefb74a8ef7"}', '2026-09-30 16:10:28.657775+09', '2026-09-30 16:10:28.666+09', 'runtime.tick', 1, '2026-09-30 16:10:28.68474+09', NULL, NULL, '2026-09-30 16:10:28.657775+09');
INSERT INTO public.outbox VALUES ('2e23c62a-4080-46c9-a820-745b59a6e19f', 'tenant-c', 'embed', '{"memoryId": "04033cd4-9639-4081-aef9-c5f4edf9ec8b"}', '2026-09-30 16:10:28.660488+09', '2026-09-30 16:10:28.666+09', 'runtime.tick', 1, '2026-09-30 16:10:28.6863+09', NULL, NULL, '2026-09-30 16:10:28.660488+09');
INSERT INTO public.outbox VALUES ('86285b87-b24f-481a-89f8-8c197b23dfe7', 'tenant-c', 'embed', '{"memoryId": "a00cde4a-97e6-4621-b312-1ab2065791f1"}', '2026-09-30 16:10:28.662922+09', '2026-09-30 16:10:28.666+09', 'runtime.tick', 1, '2026-09-30 16:10:28.687964+09', NULL, NULL, '2026-09-30 16:10:28.662922+09');
INSERT INTO public.outbox VALUES ('8eb0b529-825f-4a47-9e76-2aed47a2e8b1', 'tenant-c', 'embed', '{"memoryId": "6031bd81-b545-4b72-9737-2073ebdd0c42"}', '2026-09-30 16:10:28.665432+09', '2026-09-30 16:10:28.666+09', 'runtime.tick', 1, NULL, '2026-09-30 16:10:28.689935+09', 'fixture: embedding provider failure', '2026-09-30 16:10:28.665432+09');
INSERT INTO public.outbox VALUES ('065b7d1b-9b0a-43fb-b171-ad33b5083e9c', 'tenant-c', 'embed', '{"memoryId": "9efcc2f7-6130-4276-9b83-e64b09deaac3"}', '2026-09-30 16:10:28.692684+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-30 16:10:28.692684+09');
INSERT INTO public.outbox VALUES ('26593382-8cc5-4836-937e-fdb1b7d2bd70', 'tenant-c', 'extract', '{"observationId": "fe42f01d-6aa4-4482-92de-2e34fcd3b584"}', '2026-09-30 16:10:28.690362+09', NULL, NULL, 0, '2026-09-30 16:10:28.694301+09', NULL, NULL, '2026-09-30 16:10:28.690362+09');
INSERT INTO public.outbox VALUES ('600e6df3-e9c0-403e-80cf-4738500307f7', 'tenant-c', 'embed', '{"memoryId": "f6e5b0de-b8fc-457a-b825-8887d9e63931"}', '2026-09-30 16:10:28.696044+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-30 16:10:28.696044+09');
INSERT INTO public.outbox VALUES ('8e81125a-470d-487e-84d0-2bc4eb947016', 'tenant-c', 'extract', '{"observationId": "482310e0-72f1-429a-8470-7391cd2b0cd8"}', '2026-09-30 16:10:28.694723+09', NULL, NULL, 0, '2026-09-30 16:10:28.697451+09', NULL, NULL, '2026-09-30 16:10:28.694723+09');
INSERT INTO public.outbox VALUES ('6cb24a1d-088d-4396-b4e7-cc59dd35138e', 'tenant-c', 'embed', '{"memoryId": "aeb1c34f-fe5c-43ab-bfde-3af9000488f7"}', '2026-09-30 16:10:28.698939+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-30 16:10:28.698939+09');
INSERT INTO public.outbox VALUES ('0858b980-6b7c-4d4c-bf0e-431365e7e8d7', 'tenant-c', 'extract', '{"observationId": "cf6fa671-3757-444e-bb02-52e573c9817d"}', '2026-09-30 16:10:28.697864+09', NULL, NULL, 0, '2026-09-30 16:10:28.700301+09', NULL, NULL, '2026-09-30 16:10:28.697864+09');
INSERT INTO public.outbox VALUES ('29c6af9e-a13d-44c8-a7c0-44b32e0cf756', 'tenant-a2', 'extract', '{"observationId": "00146ece-dfb1-4c18-b274-f804695477f6"}', '2026-09-30 16:10:28.716+09', NULL, NULL, 0, '2026-09-30 16:10:28.718497+09', NULL, NULL, '2026-09-30 16:10:28.716+09');
INSERT INTO public.outbox VALUES ('15cbb070-947e-4964-8180-2a057801e1e9', 'tenant-a2', 'extract', '{"observationId": "69c45eab-23b5-4545-b619-1ed91221a75b"}', '2026-09-30 16:10:28.718928+09', NULL, NULL, 0, '2026-09-30 16:10:28.721788+09', NULL, NULL, '2026-09-30 16:10:28.718928+09');
INSERT INTO public.outbox VALUES ('60f0b414-d9e2-46db-89d0-ce6730abdfaf', 'tenant-a2', 'extract', '{"observationId": "41504b63-b402-4ae1-9e79-abcb9e801955"}', '2026-09-30 16:10:28.722189+09', NULL, NULL, 0, '2026-09-30 16:10:28.724566+09', NULL, NULL, '2026-09-30 16:10:28.722189+09');
INSERT INTO public.outbox VALUES ('382c3ebf-7485-4013-bd09-46f067ea5dd9', 'tenant-a2', 'extract', '{"observationId": "6551e295-d41c-4f47-add8-6b2d23df0308"}', '2026-09-30 16:10:28.725419+09', NULL, NULL, 0, '2026-09-30 16:10:28.728499+09', NULL, NULL, '2026-09-30 16:10:28.725419+09');
INSERT INTO public.outbox VALUES ('aaf49619-e395-4efc-8c2c-c8970c095ea7', 'tenant-a2', 'embed', '{"memoryId": "5edcbe69-cc3f-4cd1-a611-a0bc6da517c6"}', '2026-09-30 16:10:28.717101+09', '2026-09-30 16:10:28.751+09', 'runtime.tick', 1, '2026-09-30 16:10:28.754289+09', NULL, NULL, '2026-09-30 16:10:28.717101+09');
INSERT INTO public.outbox VALUES ('c3f9b4e2-c2c6-453c-a643-73d00c0b12ee', 'tenant-a2', 'extract', '{"observationId": "57b3e37b-cb8a-49f7-bd53-7fbf8708af81"}', '2026-09-30 16:10:28.72891+09', NULL, NULL, 0, '2026-09-30 16:10:28.731261+09', NULL, NULL, '2026-09-30 16:10:28.72891+09');
INSERT INTO public.outbox VALUES ('19656168-0f11-43af-bac2-385462831dc9', 'tenant-a2', 'extract', '{"observationId": "0ccc9173-835d-4bdb-a545-91e437ba77e3"}', '2026-09-30 16:10:28.731657+09', NULL, NULL, 0, '2026-09-30 16:10:28.734299+09', NULL, NULL, '2026-09-30 16:10:28.731657+09');
INSERT INTO public.outbox VALUES ('7116a2ee-08e8-4eea-8c8a-4e02e1f1230a', 'tenant-a2', 'extract', '{"observationId": "8074c4a0-3534-41ff-99f7-f66ab0e918c0"}', '2026-09-30 16:10:28.734686+09', NULL, NULL, 0, '2026-09-30 16:10:28.737021+09', NULL, NULL, '2026-09-30 16:10:28.734686+09');
INSERT INTO public.outbox VALUES ('fc507921-8b39-4474-bff8-4f7c3e834630', 'tenant-a2', 'extract', '{"observationId": "1f53fa34-341b-4866-a248-7690e5a509f5"}', '2026-09-30 16:10:28.737402+09', NULL, NULL, 0, '2026-09-30 16:10:28.740448+09', NULL, NULL, '2026-09-30 16:10:28.737402+09');
INSERT INTO public.outbox VALUES ('b3b3a562-68d3-4181-aeca-728f6dc89411', 'tenant-a2', 'extract', '{"observationId": "a560737a-6d4c-4753-852f-844bd132ae23"}', '2026-09-30 16:10:28.740921+09', NULL, NULL, 0, '2026-09-30 16:10:28.743615+09', NULL, NULL, '2026-09-30 16:10:28.740921+09');
INSERT INTO public.outbox VALUES ('e8e3c051-7e1a-4735-a658-8626c441ad21', 'tenant-a2', 'extract', '{"observationId": "50516e9d-2dba-4bf8-be6c-8489bdd7f2e1"}', '2026-09-30 16:10:28.744188+09', NULL, NULL, 0, '2026-09-30 16:10:28.747489+09', NULL, NULL, '2026-09-30 16:10:28.744188+09');
INSERT INTO public.outbox VALUES ('82c74e21-3948-4cb9-a773-b93b5adc3331', 'tenant-a2', 'extract', '{"observationId": "8f97f8b5-12b3-410f-b143-6eb05e4905da"}', '2026-09-30 16:10:28.747976+09', NULL, NULL, 0, '2026-09-30 16:10:28.751215+09', NULL, NULL, '2026-09-30 16:10:28.747976+09');
INSERT INTO public.outbox VALUES ('a16a0f26-c1aa-41f4-9e02-461d9701f015', 'tenant-a2', 'embed', '{"memoryId": "9e33ee7a-e83d-45c2-8d50-0e5fadc3e5db"}', '2026-09-30 16:10:28.720366+09', '2026-09-30 16:10:28.751+09', 'runtime.tick', 1, '2026-09-30 16:10:28.756216+09', NULL, NULL, '2026-09-30 16:10:28.720366+09');
INSERT INTO public.outbox VALUES ('c07bbea6-778e-43d5-a95f-cd11c06e2562', 'tenant-a2', 'embed', '{"memoryId": "4f45de75-e881-4856-8d05-aad412e744c3"}', '2026-09-30 16:10:28.723205+09', '2026-09-30 16:10:28.751+09', 'runtime.tick', 1, '2026-09-30 16:10:28.757859+09', NULL, NULL, '2026-09-30 16:10:28.723205+09');
INSERT INTO public.outbox VALUES ('b258d7ee-b0a3-4cab-a1cf-80f859b6fa4b', 'tenant-a2', 'embed', '{"memoryId": "5cd10797-6df6-49d8-8eb4-e901fc41cc7c"}', '2026-09-30 16:10:28.726789+09', '2026-09-30 16:10:28.751+09', 'runtime.tick', 1, '2026-09-30 16:10:28.759501+09', NULL, NULL, '2026-09-30 16:10:28.726789+09');
INSERT INTO public.outbox VALUES ('972bc564-5162-412b-bdfc-f6a75c82b45a', 'tenant-a2', 'embed', '{"memoryId": "f8bdff5b-da7e-48aa-802f-f5ca4eb792be"}', '2026-09-30 16:10:28.729894+09', '2026-09-30 16:10:28.751+09', 'runtime.tick', 1, '2026-09-30 16:10:28.761314+09', NULL, NULL, '2026-09-30 16:10:28.729894+09');
INSERT INTO public.outbox VALUES ('cb68485a-6232-4ea5-b663-f3a85f88d190', 'tenant-a2', 'embed', '{"memoryId": "9125e691-5d32-4e89-bee6-2a2d96ca3235"}', '2026-09-30 16:10:28.732715+09', '2026-09-30 16:10:28.751+09', 'runtime.tick', 1, '2026-09-30 16:10:28.763129+09', NULL, NULL, '2026-09-30 16:10:28.732715+09');
INSERT INTO public.outbox VALUES ('17cdc580-d28d-4671-bc0e-51ab65efb202', 'tenant-a2', 'embed', '{"memoryId": "97981b11-aee7-45ea-a2eb-c24d3eae9ce2"}', '2026-09-30 16:10:28.73568+09', '2026-09-30 16:10:28.751+09', 'runtime.tick', 1, '2026-09-30 16:10:28.764727+09', NULL, NULL, '2026-09-30 16:10:28.73568+09');
INSERT INTO public.outbox VALUES ('9c0c0ff9-56d5-421c-a14d-006076efbfce', 'tenant-a2', 'embed', '{"memoryId": "287a2f8e-9486-426b-8adf-c18e9f02f01e"}', '2026-09-30 16:10:28.738759+09', '2026-09-30 16:10:28.751+09', 'runtime.tick', 1, '2026-09-30 16:10:28.766217+09', NULL, NULL, '2026-09-30 16:10:28.738759+09');
INSERT INTO public.outbox VALUES ('fae7eb34-b38e-4016-91de-5f10376104ef', 'tenant-a2', 'embed', '{"memoryId": "04080c4e-4828-478f-a4fc-9fce71877410"}', '2026-09-30 16:10:28.742142+09', '2026-09-30 16:10:28.751+09', 'runtime.tick', 1, '2026-09-30 16:10:28.768025+09', NULL, NULL, '2026-09-30 16:10:28.742142+09');
INSERT INTO public.outbox VALUES ('a271c9cf-47a9-4f66-8b4f-e6df7d874fff', 'tenant-a2', 'embed', '{"memoryId": "09458b38-45e0-424f-b606-f422bca00e46"}', '2026-09-30 16:10:28.745415+09', '2026-09-30 16:10:28.751+09', 'runtime.tick', 1, '2026-09-30 16:10:28.769556+09', NULL, NULL, '2026-09-30 16:10:28.745415+09');
INSERT INTO public.outbox VALUES ('a1e1e63d-302e-4eb8-8e2c-632fc6303e8a', 'tenant-a2', 'embed', '{"memoryId": "51bcf032-4265-47d1-be97-7315e758f0f2"}', '2026-09-30 16:10:28.749612+09', '2026-09-30 16:10:28.751+09', 'runtime.tick', 1, NULL, '2026-09-30 16:10:28.770807+09', 'fixture: embedding provider failure', '2026-09-30 16:10:28.749612+09');
INSERT INTO public.outbox VALUES ('febdb3e4-c872-4cbe-aa89-8012ccea014a', 'tenant-a2', 'embed', '{"memoryId": "37ca332a-60df-40b4-add5-0b80cc38dd49"}', '2026-09-30 16:10:28.772437+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-30 16:10:28.772437+09');
INSERT INTO public.outbox VALUES ('ebe400f9-2663-4e5f-a07e-a39cf3be38d5', 'tenant-a2', 'extract', '{"observationId": "a0534cb7-ee9a-4aac-aa48-af5da5eb4572"}', '2026-09-30 16:10:28.771199+09', NULL, NULL, 0, '2026-09-30 16:10:28.773766+09', NULL, NULL, '2026-09-30 16:10:28.771199+09');
INSERT INTO public.outbox VALUES ('2e9d2f4e-8e2f-4783-a165-57c8ebc342bc', 'tenant-a2', 'embed', '{"memoryId": "f193d97d-23d3-4df2-aa57-e305e2196534"}', '2026-09-30 16:10:28.775388+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-30 16:10:28.775388+09');
INSERT INTO public.outbox VALUES ('36b37159-d772-48e7-80ca-48d4ac41ddbb', 'tenant-a2', 'extract', '{"observationId": "122bfe15-0289-4e27-85cd-f18a8aeba1c2"}', '2026-09-30 16:10:28.774181+09', NULL, NULL, 0, '2026-09-30 16:10:28.79709+09', NULL, NULL, '2026-09-30 16:10:28.774181+09');
INSERT INTO public.outbox VALUES ('1c0a4d09-94dd-40f2-8966-022d3def8d9d', 'tenant-a2', 'embed', '{"memoryId": "66a93937-8913-4661-9b63-85c4f0877869"}', '2026-09-30 16:10:28.799577+09', NULL, NULL, 0, NULL, NULL, NULL, '2026-09-30 16:10:28.799577+09');
INSERT INTO public.outbox VALUES ('f398e07c-476c-43cd-9d8c-a3c3e4e505e2', 'tenant-a2', 'extract', '{"observationId": "143b2d68-cf0b-4510-9f37-64c91d0d6ee6"}', '2026-09-30 16:10:28.797938+09', NULL, NULL, 0, '2026-09-30 16:10:28.801161+09', NULL, NULL, '2026-09-30 16:10:28.797938+09');


--
-- Data for Name: recall_usages; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.recall_usages VALUES ('tenant-a', 'a41c44fe-7ee5-4451-824e-bab2134f9fd0', 'd21a2085-0e80-481f-8a1a-47d62e379080', '2026-09-30 16:10:28.474078+09');
INSERT INTO public.recall_usages VALUES ('tenant-b', '08c156fa-9d24-4d4f-8454-4108c48ba46f', 'e063c891-63b5-427c-9678-484e0cfec148', '2026-09-30 16:10:28.627464+09');
INSERT INTO public.recall_usages VALUES ('tenant-c', '328f9e83-958f-4c5b-972b-5094a9828089', '86537f40-a1c3-4777-a868-66f1622eb652', '2026-09-30 16:10:28.714321+09');
INSERT INTO public.recall_usages VALUES ('tenant-a2', '2d4cbb0c-65e2-4785-bfa4-b0f8db9dd135', '4f45de75-e881-4856-8d05-aad412e744c3', '2026-09-30 16:10:28.820082+09');


--
-- Data for Name: recalls; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.recalls VALUES ('a41c44fe-7ee5-4451-824e-bab2134f9fd0', 'tenant-a', NULL, '{"text": "東京 会議", "limit": 5}', NULL, '[{"kind": "score_not_comparable", "count": 2, "countKind": "exact"}, {"kind": "over_limit", "count": 13, "stage": "rescore", "countKind": "exact"}, {"kind": "ann_truncated", "certainty": "undecidable", "countKind": "unknown", "undecidableReason": "ANN が返した最後の similarity が 0 以下または非有限である（NaN）。この場合、上界の不等式は total の順序を保証しない。"}, {"kind": "filtered", "count": 1, "condition": "archived", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 1, "condition": "superseded", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 2, "condition": "forgotten", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "not_indexed", "count": 2, "reason": "pending", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "failed", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "skipped", "countKind": "exact"}]', '{"chars": 2063, "byTier": {"full": 0, "index": 1918, "digest": 145}, "counter": "heuristic", "indexChars": 1918, "estimatedTokens": 701}', '{"groups": [{"key": null, "axis": "subject", "count": 24, "countKind": "exact"}], "countKind": "exact", "digestBand": [{"digest": "tenant-a 未埋め込み 2", "memoryId": "a473bc10-58af-4d43-a483-98ae7237f4cd"}, {"digest": "tenant-a 未埋め込み 1", "memoryId": "19e371cd-0bc5-4a2e-bdd3-926c3e06a039"}, {"digest": "tenant-a 未埋め込み 0", "memoryId": "fd3d3f38-8d19-4f69-bc0c-bde37829b600"}, {"digest": "tenant-a FAIL 埋め込み失敗 東京", "memoryId": "8688815a-d446-472b-beed-78717974d078"}, {"digest": "tenant-a の記憶 23 東京 会議 プロジェクト3", "memoryId": "8f147a2c-4cb8-4320-a1b6-db425fdad60b"}, {"digest": "tenant-a の記憶 19 東京 会議 プロジェクト4", "memoryId": "790d7bb0-7be7-410d-a875-69d94b4bd0ff"}, {"digest": "tenant-a の記憶 18 東京 会議 プロジェクト3", "memoryId": "52352eb6-6c20-449b-bde9-92ceefad2119"}, {"digest": "tenant-a の記憶 17 東京 会議 プロジェクト2 ZERO", "memoryId": "7f850fd5-b588-4e98-810e-61880d17f5dc"}, {"digest": "tenant-a の記憶 16 東京 会議 プロジェクト1", "memoryId": "2ad5f6f4-6af3-480a-963d-c2581e800298"}, {"digest": "tenant-a の記憶 14 東京 会議 プロジェクト4", "memoryId": "7a65904e-aa1f-4438-9fa2-702c1d6fb953"}, {"digest": "tenant-a の記憶 13 東京 会議 プロジェクト3", "memoryId": "0142288a-451a-4d56-99e8-31edb1a7d52a"}, {"digest": "tenant-a の記憶 8 東京 会議 プロジェクト3", "memoryId": "db52e2d3-3a70-4031-b38b-99a212ee5ce5"}, {"digest": "tenant-a の記憶 7 東京 会議 プロジェクト2", "memoryId": "6c000d76-3068-4f9a-b7f2-bf49c407604c"}, {"digest": "tenant-a の記憶 6 東京 会議 プロジェクト1", "memoryId": "71959e35-ff92-4e32-a488-24ac50e52e23"}, {"digest": "tenant-a の記憶 5 東京 会議 プロジェクト0", "memoryId": "9f6e751a-d10d-4867-894c-3b3318fc5ad6"}, {"digest": "tenant-a の記憶 3 東京 会議 プロジェクト3 ZERO", "memoryId": "d6871336-2ab3-4100-81c0-1418236588ac"}, {"digest": "tenant-a の記憶 2 東京 会議 プロジェクト2", "memoryId": "cdaec7f7-e905-4944-bea0-efbd5313f206"}, {"digest": "tenant-a の記憶 1 東京 会議 プロジェクト1", "memoryId": "385ddb84-f30d-45b6-a610-a90f4fa542da"}, {"digest": "tenant-a の記憶 0 東京 会議 プロジェクト0", "memoryId": "e9b4837a-7259-4c1f-ac42-623c40b65da8"}], "totalInScope": 24, "digestBandCoverage": {"shown": 19, "eligible": 19, "countKind": "exact"}}', '{"stages": [{"stage": "scope", "detail": {"validAt": "2026-09-30T07:10:28.459Z", "subjectId": null, "occurredAfter": null, "occurredBefore": null}, "executed": true}, {"stage": "candidate_generation", "detail": {"hits": 20, "clock": "wall", "kPrime": 20, "channel": "ann", "decayGate": "pushed_down", "validityGate": "pushed_down"}, "executed": true}, {"stage": "rescore", "detail": {"scored": 20, "withinLimit": 5, "notComparable": 2, "passedThreshold": 18}, "executed": true}, {"stage": "contradiction_resolution", "detail": {"companionsAdded": 0}, "executed": true}, {"stage": "budget_truncation", "detail": {"unitsKept": 5, "budgetApplied": false}, "executed": true}, {"stage": "index_band", "detail": {"totalInScope": 24}, "executed": true}, {"stage": "record", "executed": true}]}', '2026-09-30 16:10:28.466018+09', '{"memories": [{"score": {"decay": 0.9999999692469427, "total": 0.7063611640026601, "strength": 1, "tagMatch": 1, "freshness": 0.9999999692469427, "similarity": 0.7063612074481929}, "memoryId": "d21a2085-0e80-481f-8a1a-47d62e379080", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999703166143, "total": 0.7058285111906643, "strength": 1, "tagMatch": 1, "freshness": 0.9999999703166143, "similarity": 0.7058285530934261}, "memoryId": "5a7107e4-b415-4912-a260-b5ba85543982", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999630963313, "total": 0.705791028716246, "strength": 1, "tagMatch": 1, "freshness": 0.9999999630963313, "similarity": 0.7057910808088055}, "memoryId": "75e7ec0d-7c97-455d-828a-7be812c96d5a", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999601547346, "total": 0.705645383987249, "strength": 1, "tagMatch": 1, "freshness": 0.9999999601547346, "similarity": 0.7056454402205076}, "memoryId": "f3153b73-6258-450f-ae4a-19807dbacb14", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999711188678, "total": 0.7052962467773612, "strength": 1, "tagMatch": 1, "freshness": 0.9999999711188678, "similarity": 0.7052962875168712}, "memoryId": "decede7e-0883-47c7-a8e3-0333baa2b19c", "retrievedVia": "ann"}], "breakdownCaptured": true}');
INSERT INTO public.recalls VALUES ('08c156fa-9d24-4d4f-8454-4108c48ba46f', 'tenant-b', NULL, '{"text": "東京 会議", "limit": 5}', NULL, '[{"kind": "score_not_comparable", "count": 2, "countKind": "exact"}, {"kind": "over_limit", "count": 6, "stage": "rescore", "countKind": "exact"}, {"kind": "filtered", "count": 1, "condition": "archived", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 1, "condition": "superseded", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 3, "condition": "forgotten", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "not_indexed", "count": 2, "reason": "pending", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "failed", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "skipped", "countKind": "exact"}]', '{"chars": 1413, "byTier": {"full": 0, "index": 1268, "digest": 145}, "counter": "heuristic", "indexChars": 1268, "estimatedTokens": 480}', '{"groups": [{"key": null, "axis": "subject", "count": 17, "countKind": "exact"}], "countKind": "exact", "digestBand": [{"digest": "tenant-b 未埋め込み 2", "memoryId": "3d8b7a59-9446-4c53-9ae9-c289e288ca6f"}, {"digest": "tenant-b 未埋め込み 1", "memoryId": "f4732ff5-ac81-4824-8b4c-b4fab0e0ccec"}, {"digest": "tenant-b 未埋め込み 0", "memoryId": "6b031499-48ac-43ea-809f-9e706588e681"}, {"digest": "tenant-b FAIL 埋め込み失敗 東京", "memoryId": "464f2fd3-d8aa-4282-a8e2-81c77162e584"}, {"digest": "tenant-b の記憶 17 東京 会議 プロジェクト2 ZERO", "memoryId": "b6b09149-9e0a-44ea-8d8e-5e398a2b28c2"}, {"digest": "tenant-b の記憶 7 東京 会議 プロジェクト2", "memoryId": "af28ef0f-9e57-4941-a5d7-100fb2d99d1c"}, {"digest": "tenant-b の記憶 6 東京 会議 プロジェクト1", "memoryId": "30d58bb2-fc98-4a76-ad29-9ce67eaab64c"}, {"digest": "tenant-b の記憶 5 東京 会議 プロジェクト0", "memoryId": "a7b25522-dfdd-472c-b6d7-94186b139d05"}, {"digest": "tenant-b の記憶 3 東京 会議 プロジェクト3 ZERO", "memoryId": "a8bdd009-902e-4d8e-aa86-46533de82784"}, {"digest": "tenant-b の記憶 2 東京 会議 プロジェクト2", "memoryId": "9d84c4ff-7580-46dd-a1f4-25701838f3a3"}, {"digest": "tenant-b の記憶 1 東京 会議 プロジェクト1", "memoryId": "98523396-eb33-468d-adbe-fd392d2bbb55"}, {"digest": "tenant-b の記憶 0 東京 会議 プロジェクト0", "memoryId": "602d957e-cff9-425f-b386-8565c7af9783"}], "totalInScope": 17, "digestBandCoverage": {"shown": 12, "eligible": 12, "countKind": "exact"}}', '{"stages": [{"stage": "scope", "detail": {"validAt": "2026-09-30T07:10:28.623Z", "subjectId": null, "occurredAfter": null, "occurredBefore": null}, "executed": true}, {"stage": "candidate_generation", "detail": {"hits": 13, "clock": "wall", "kPrime": 20, "channel": "ann", "decayGate": "pushed_down", "validityGate": "pushed_down"}, "executed": true}, {"stage": "rescore", "detail": {"scored": 13, "withinLimit": 5, "notComparable": 2, "passedThreshold": 11}, "executed": true}, {"stage": "contradiction_resolution", "detail": {"companionsAdded": 0}, "executed": true}, {"stage": "budget_truncation", "detail": {"unitsKept": 5, "budgetApplied": false}, "executed": true}, {"stage": "index_band", "detail": {"totalInScope": 17}, "executed": true}, {"stage": "record", "executed": true}]}', '2026-09-30 16:10:28.625837+09', '{"memories": [{"score": {"decay": 0.9999999764672256, "total": 0.6564810108628363, "strength": 1, "tagMatch": 1, "freshness": 0.9999999764672256, "similarity": 0.6564810417604764}, "memoryId": "e063c891-63b5-427c-9678-484e0cfec148", "retrievedVia": "ann"}, {"score": {"decay": 0.999999975397554, "total": 0.6564712413029116, "strength": 1, "tagMatch": 1, "freshness": 0.999999975397554, "similarity": 0.6564712736045092}, "memoryId": "3805ce1a-03ae-4ee7-9ffb-3dbab94f05e1", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999740604646, "total": 0.6564612325650869, "strength": 1, "tagMatch": 1, "freshness": 0.9999999740604646, "similarity": 0.6564612666216871}, "memoryId": "8827e601-7f09-43cf-beb7-51fb0a6ca239", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999780717329, "total": 0.6554165897600648, "strength": 1, "tagMatch": 1, "freshness": 0.9999999780717329, "similarity": 0.6554166185043658}, "memoryId": "f2ab6369-c531-4f9f-89d1-93c0ec5b6967", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999772694793, "total": 0.6554060749268015, "strength": 1, "tagMatch": 1, "freshness": 0.9999999772694793, "similarity": 0.6554061047222453}, "memoryId": "0ad4b72a-6e8a-47f5-a17b-5a15e8480e25", "retrievedVia": "ann"}], "breakdownCaptured": true}');
INSERT INTO public.recalls VALUES ('328f9e83-958f-4c5b-972b-5094a9828089', 'tenant-c', NULL, '{"text": "東京 会議", "limit": 5}', NULL, '[{"kind": "score_not_comparable", "count": 1, "countKind": "exact"}, {"kind": "over_limit", "count": 1, "stage": "rescore", "countKind": "exact"}, {"kind": "filtered", "count": 1, "condition": "archived", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 1, "condition": "superseded", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 3, "condition": "forgotten", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "not_indexed", "count": 2, "reason": "pending", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "failed", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "skipped", "countKind": "exact"}]', '{"chars": 784, "byTier": {"full": 0, "index": 616, "digest": 168}, "counter": "heuristic", "indexChars": 616, "estimatedTokens": 272}', '{"groups": [{"key": null, "axis": "subject", "count": 11, "countKind": "exact"}], "countKind": "exact", "digestBand": [{"digest": "tenant-c 未埋め込み 2", "memoryId": "aeb1c34f-fe5c-43ab-bfde-3af9000488f7"}, {"digest": "tenant-c 未埋め込み 1", "memoryId": "f6e5b0de-b8fc-457a-b825-8887d9e63931"}, {"digest": "tenant-c 未埋め込み 0", "memoryId": "9efcc2f7-6130-4276-9b83-e64b09deaac3"}, {"digest": "tenant-c FAIL 埋め込み失敗 東京", "memoryId": "6031bd81-b545-4b72-9737-2073ebdd0c42"}, {"digest": "tenant-c の記憶 3 東京 会議 プロジェクト3 ZERO", "memoryId": "e7dc9134-bf43-46b6-ad48-1530fadfddff"}], "totalInScope": 11, "digestBandCoverage": {"shown": 5, "eligible": 5, "countKind": "exact"}}', '{"stages": [{"stage": "scope", "detail": {"validAt": "2026-09-30T07:10:28.710Z", "subjectId": null, "occurredAfter": null, "occurredBefore": null}, "executed": true}, {"stage": "candidate_generation", "detail": {"hits": 7, "clock": "wall", "kPrime": 20, "channel": "ann", "decayGate": "pushed_down", "validityGate": "pushed_down"}, "executed": true}, {"stage": "rescore", "detail": {"scored": 7, "withinLimit": 5, "notComparable": 1, "passedThreshold": 6}, "executed": true}, {"stage": "contradiction_resolution", "detail": {"companionsAdded": 1}, "executed": true}, {"stage": "budget_truncation", "detail": {"unitsKept": 5, "budgetApplied": false}, "executed": true}, {"stage": "index_band", "detail": {"totalInScope": 11}, "executed": true}, {"stage": "record", "executed": true}]}', '2026-09-30 16:10:28.712893+09', '{"memories": [{"score": {"decay": 0.9999999804784939, "total": 0.544669923312282, "strength": 1, "tagMatch": 1, "freshness": 0.9999999804784939, "similarity": 0.5446699445778371}, "memoryId": "86537f40-a1c3-4777-a868-66f1622eb652", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999794088223, "total": 0.5442745708189413, "strength": 1, "tagMatch": 1, "freshness": 0.9999999794088223, "similarity": 0.5442745932334506}, "memoryId": "bcd20266-65d9-4d90-b8fe-4eee19f5d0b7", "retrievedVia": "ann"}, {"score": {"decay": 0.999999985292016, "total": 0.5442011017649113, "strength": 1, "tagMatch": 1, "freshness": 0.999999985292016, "similarity": 0.544201117773114}, "memoryId": "91ce637e-a3a0-4936-909c-2c31d8d5b039", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999836875086, "total": 0.9999999673750175, "strength": 1, "tagMatch": 1, "freshness": 0.9999999836875086}, "memoryId": "69eca64a-eb31-45e3-8ac8-d79a5590b8da", "companionOf": "91ce637e-a3a0-4936-909c-2c31d8d5b039", "retrievedVia": "mandatory_companion"}, {"score": {"decay": 0.9999999786065688, "total": 0.5438775837759101, "strength": 1, "tagMatch": 1, "freshness": 0.9999999786065688, "similarity": 0.5438776070467263}, "memoryId": "67a19942-fd02-4e21-b29c-fe6c3235e52e", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999844897622, "total": 0.5438076680515838, "strength": 1, "tagMatch": 1, "freshness": 0.9999999844897622, "similarity": 0.5438076849207566}, "memoryId": "a5d1f82f-80cd-4f39-8067-47e16e0e8f6f", "retrievedVia": "ann"}], "breakdownCaptured": true}');
INSERT INTO public.recalls VALUES ('2d4cbb0c-65e2-4785-bfa4-b0f8db9dd135', 'tenant-a2', NULL, '{"text": "東京 会議", "limit": 5}', NULL, '[{"kind": "score_not_comparable", "count": 1, "countKind": "exact"}, {"kind": "over_limit", "count": 2, "stage": "rescore", "countKind": "exact"}, {"kind": "filtered", "count": 1, "condition": "archived", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 1, "condition": "superseded", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "filtered", "count": 2, "condition": "forgotten", "countKind": "exact", "scopeRelation": "outside_scope"}, {"kind": "not_indexed", "count": 1, "reason": "failed", "countKind": "exact"}, {"kind": "not_indexed", "count": 1, "reason": "skipped", "countKind": "exact"}]', '{"chars": 726, "byTier": {"full": 0, "index": 552, "digest": 174}, "counter": "heuristic", "indexChars": 552, "estimatedTokens": 259}', '{"groups": [{"key": null, "axis": "subject", "count": 10, "countKind": "exact"}], "countKind": "exact", "digestBand": [{"digest": "tenant-a2 未埋め込み 2", "memoryId": "66a93937-8913-4661-9b63-85c4f0877869"}, {"digest": "tenant-a2 FAIL 埋め込み失敗 東京", "memoryId": "51bcf032-4265-47d1-be97-7315e758f0f2"}, {"digest": "tenant-a2 の記憶 5 東京 会議 プロジェクト0", "memoryId": "9125e691-5d32-4e89-bee6-2a2d96ca3235"}, {"digest": "tenant-a2 の記憶 3 東京 会議 プロジェクト3 ZERO", "memoryId": "5cd10797-6df6-49d8-8eb4-e901fc41cc7c"}], "totalInScope": 10, "digestBandCoverage": {"shown": 4, "eligible": 4, "countKind": "exact"}}', '{"stages": [{"stage": "scope", "detail": {"validAt": "2026-09-30T07:10:28.814Z", "subjectId": null, "occurredAfter": null, "occurredBefore": null}, "executed": true}, {"stage": "candidate_generation", "detail": {"hits": 8, "clock": "wall", "kPrime": 20, "channel": "ann", "decayGate": "pushed_down", "validityGate": "pushed_down"}, "executed": true}, {"stage": "rescore", "detail": {"scored": 8, "withinLimit": 5, "notComparable": 1, "passedThreshold": 7}, "executed": true}, {"stage": "contradiction_resolution", "detail": {"companionsAdded": 1}, "executed": true}, {"stage": "budget_truncation", "detail": {"unitsKept": 5, "budgetApplied": false}, "executed": true}, {"stage": "index_band", "detail": {"totalInScope": 10}, "executed": true}, {"stage": "record", "executed": true}]}', '2026-09-30 16:10:28.818368+09', '{"memories": [{"score": {"decay": 0.999999975397554, "total": 0.3296480702311317, "strength": 1, "tagMatch": 1, "freshness": 0.999999975397554, "similarity": 0.32964808645142996}, "memoryId": "4f45de75-e881-4856-8d05-aad412e744c3", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999804784939, "total": 0.32951252354544724, "strength": 1, "tagMatch": 1, "freshness": 0.9999999804784939, "similarity": 0.32951253641060907}, "memoryId": "04080c4e-4828-478f-a4fc-9fce71877410", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999788739866, "total": 0.9999999577479737, "strength": 1, "tagMatch": 1, "freshness": 0.9999999788739866}, "memoryId": "97981b11-aee7-45ea-a2eb-c24d3eae9ce2", "companionOf": "04080c4e-4828-478f-a4fc-9fce71877410", "retrievedVia": "mandatory_companion"}, {"score": {"decay": 0.9999999748627183, "total": 0.32920263472092554, "strength": 1, "tagMatch": 1, "freshness": 0.9999999748627183, "similarity": 0.3292026512714449}, "memoryId": "9e33ee7a-e83d-45c2-8d50-0e5fadc3e5db", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999796762403, "total": 0.32906899271576884, "strength": 1, "tagMatch": 1, "freshness": 0.9999999796762403, "similarity": 0.3290690060916075}, "memoryId": "287a2f8e-9486-426b-8adf-c18e9f02f01e", "retrievedVia": "ann"}, {"score": {"decay": 0.9999999737930467, "total": 0.3287565433485242, "strength": 1, "tagMatch": 1, "freshness": 0.9999999737930467, "similarity": 0.3287565605799396}, "memoryId": "5edcbe69-cc3f-4cd1-a611-a0bc6da517c6", "retrievedVia": "ann"}], "breakdownCaptured": true}');


--
-- Data for Name: tenant_activity; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: tenant_settings; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Name: _mnemora_migrations _mnemora_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._mnemora_migrations
    ADD CONSTRAINT _mnemora_migrations_pkey PRIMARY KEY (name);


--
-- Name: memories memories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_pkey PRIMARY KEY (id);


--
-- Name: memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 memory_embeddings_some_very_long_provider_name_an_extr_b34_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257
    ADD CONSTRAINT memory_embeddings_some_very_long_provider_name_an_extr_b34_pkey PRIMARY KEY (tenant_id, memory_id);


--
-- Name: memory_embeddings_test_fixture_model_3 memory_embeddings_test_fixture_model_3_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_embeddings_test_fixture_model_3
    ADD CONSTRAINT memory_embeddings_test_fixture_model_3_pkey PRIMARY KEY (tenant_id, memory_id);


--
-- Name: memory_embeddings_testkit_deterministic_8 memory_embeddings_testkit_deterministic_8_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_embeddings_testkit_deterministic_8
    ADD CONSTRAINT memory_embeddings_testkit_deterministic_8_pkey PRIMARY KEY (tenant_id, memory_id);


--
-- Name: memory_events memory_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_events
    ADD CONSTRAINT memory_events_pkey PRIMARY KEY (id);


--
-- Name: observations observations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.observations
    ADD CONSTRAINT observations_pkey PRIMARY KEY (id);


--
-- Name: outbox outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox
    ADD CONSTRAINT outbox_pkey PRIMARY KEY (id);


--
-- Name: recall_usages recall_usages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_usages
    ADD CONSTRAINT recall_usages_pkey PRIMARY KEY (tenant_id, recall_id, memory_id);


--
-- Name: recalls recalls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recalls
    ADD CONSTRAINT recalls_pkey PRIMARY KEY (id);


--
-- Name: tenant_activity tenant_activity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_activity
    ADD CONSTRAINT tenant_activity_pkey PRIMARY KEY (tenant_id);


--
-- Name: tenant_settings tenant_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_settings
    ADD CONSTRAINT tenant_settings_pkey PRIMARY KEY (tenant_id);


--
-- Name: idx_memories_by_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_by_subject ON public.memories USING btree (tenant_id, subject_id, status);


--
-- Name: idx_memories_contested; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_contested ON public.memories USING btree (tenant_id, status) WHERE (status = 'contested'::text);


--
-- Name: idx_memories_contested_with; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_contested_with ON public.memories USING btree (contested_with_id) WHERE (contested_with_id IS NOT NULL);


--
-- Name: idx_memories_lexical; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_lexical ON public.memories USING gin (tenant_id, to_tsvector('simple'::regconfig, public.mnemora_lexical_normalize(content))) WHERE (status = ANY (ARRAY['active'::text, 'contested'::text]));


--
-- Name: idx_memories_period_ann_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_period_ann_stage ON public.memories USING btree (tenant_id, status, COALESCE(occurred_at, recorded_at));


--
-- Name: idx_memories_provenance_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_provenance_kind ON public.memories USING btree (tenant_id, provenance_kind);


--
-- Name: idx_memories_recall_gate; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_recall_gate ON public.memories USING btree (tenant_id, status, decay_floor_at) WHERE (status = ANY (ARRAY['active'::text, 'contested'::text]));


--
-- Name: idx_memories_recall_gate_seq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_recall_gate_seq ON public.memories USING btree (tenant_id, status, decay_floor_seq) WHERE (status = ANY (ARRAY['active'::text, 'contested'::text]));


--
-- Name: idx_memories_requeue_embed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_requeue_embed ON public.memories USING btree (tenant_id, updated_at, id) WHERE ((status = ANY (ARRAY['active'::text, 'contested'::text])) AND (embedding_status <> 'ready'::text));


--
-- Name: idx_memories_superseded_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_superseded_by ON public.memories USING btree (tenant_id, superseded_by_id) WHERE (superseded_by_id IS NOT NULL);


--
-- Name: idx_memories_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_tags ON public.memories USING gin (tenant_id, tags);


--
-- Name: idx_memory_embeddings_hnsw_some_very_long_provider_nam_0428309b; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_embeddings_hnsw_some_very_long_provider_nam_0428309b ON public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: idx_memory_embeddings_hnsw_test_fixture_model_3; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_embeddings_hnsw_test_fixture_model_3 ON public.memory_embeddings_test_fixture_model_3 USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: idx_memory_embeddings_hnsw_testkit_deterministic_8; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_embeddings_hnsw_testkit_deterministic_8 ON public.memory_embeddings_testkit_deterministic_8 USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: idx_memory_events_by_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_events_by_kind ON public.memory_events USING btree (tenant_id, kind, at);


--
-- Name: idx_memory_events_by_memory; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_events_by_memory ON public.memory_events USING btree (tenant_id, memory_id, at);


--
-- Name: idx_memory_events_by_retention; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_events_by_retention ON public.memory_events USING btree (tenant_id, at);


--
-- Name: idx_observations_by_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_observations_by_subject ON public.observations USING btree (tenant_id, subject_id, recorded_at);


--
-- Name: idx_outbox_claimable; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_claimable ON public.outbox USING btree (tenant_id, available_at) WHERE ((completed_at IS NULL) AND (failed_at IS NULL));


--
-- Name: idx_outbox_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_pending ON public.outbox USING btree (tenant_id, kind, available_at) WHERE ((completed_at IS NULL) AND (claimed_at IS NULL));


--
-- Name: idx_recalls_by_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recalls_by_subject ON public.recalls USING btree (tenant_id, subject_id, created_at);


--
-- Name: uq_memories_extraction; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_memories_extraction ON public.memories USING btree (tenant_id, source_observation_id, extractor_version, content_hash) NULLS NOT DISTINCT WHERE (source_observation_id IS NOT NULL);


--
-- Name: uq_observations_external_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_observations_external_id ON public.observations USING btree (tenant_id, external_id) WHERE (external_id IS NOT NULL);


--
-- Name: memories memories_contested_with_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_contested_with_id_fkey FOREIGN KEY (contested_with_id) REFERENCES public.memories(id);


--
-- Name: memories memories_source_observation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_source_observation_id_fkey FOREIGN KEY (source_observation_id) REFERENCES public.observations(id);


--
-- Name: memories memories_superseded_by_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_superseded_by_id_fkey FOREIGN KEY (superseded_by_id) REFERENCES public.memories(id);


--
-- Name: memory_embeddings_some_very_long_provider_name_an_extr_b34ef257 memory_embeddings_some_very_long_provider_name_a_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_embeddings_some_very_long_provider_name_an_extr_b34ef257
    ADD CONSTRAINT memory_embeddings_some_very_long_provider_name_a_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES public.memories(id) ON DELETE CASCADE;


--
-- Name: memory_embeddings_test_fixture_model_3 memory_embeddings_test_fixture_model_3_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_embeddings_test_fixture_model_3
    ADD CONSTRAINT memory_embeddings_test_fixture_model_3_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES public.memories(id) ON DELETE CASCADE;


--
-- Name: memory_embeddings_testkit_deterministic_8 memory_embeddings_testkit_deterministic_8_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_embeddings_testkit_deterministic_8
    ADD CONSTRAINT memory_embeddings_testkit_deterministic_8_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES public.memories(id) ON DELETE CASCADE;


--
-- Name: memory_events memory_events_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_events
    ADD CONSTRAINT memory_events_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES public.memories(id);


--
-- Name: recall_usages recall_usages_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_usages
    ADD CONSTRAINT recall_usages_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES public.memories(id);


--
-- Name: recall_usages recall_usages_recall_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_usages
    ADD CONSTRAINT recall_usages_recall_id_fkey FOREIGN KEY (recall_id) REFERENCES public.recalls(id);


--
-- PostgreSQL database dump complete
--


