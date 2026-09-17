create extension if not exists "uuid-ossp";

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  email text unique,
  role text not null default 'customer' check (role in ('customer','admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  slug text unique not null,
  description text,
  price numeric(10,2) not null check (price >= 0),
  stock integer not null default 0 check (stock >= 0),
  image_url text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references public.profiles(id) on delete set null,
  customer_name text not null,
  customer_email text,
  customer_phone text,
  shipping_address text not null,
  status text not null default 'pending' check (status in ('pending','paid','processing','shipped','completed','cancelled')),
  total numeric(10,2) not null check (total >= 0),
  payment_method text not null default 'stripe',
  stripe_payment_intent_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  unit_price numeric(10,2) not null check (unit_price >= 0),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;

create policy "Public can view active products" on public.products
for select using (is_active = true);

create policy "Admins can manage products" on public.products
for all using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  )
)
with check (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  )
);

create policy "Users can read own profile" on public.profiles
for select using (id = auth.uid());

revoke update (role) on table public.profiles from authenticated;
grant update (full_name, email) on table public.profiles to authenticated;

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update safe profile fields" on public.profiles
for update using (id = auth.uid())
with check (id = auth.uid());

revoke insert, delete on table public.profiles from authenticated;
drop policy if exists "Users can insert own profile" on public.profiles;

create policy "Users can read own orders" on public.orders
for select using (user_id = auth.uid() or exists (
  select 1 from public.profiles p
  where p.id = auth.uid() and p.role = 'admin'
));

revoke insert, update, delete on table public.orders from authenticated;
drop policy if exists "Authenticated users can create orders" on public.orders;
drop policy if exists "Users can update own orders" on public.orders;

create policy "Users can read own order items" on public.order_items
for select using (exists (
  select 1 from public.orders o
  where o.id = order_id and (o.user_id = auth.uid() or exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  ))
));

revoke insert, update, delete on table public.order_items from authenticated;
drop policy if exists "Users can create their own order items" on public.order_items;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email, role)
  values (new.id, new.raw_user_meta_data ->> 'full_name', new.email, 'customer')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

create index if not exists idx_products_active on public.products (is_active, created_at desc);
create index if not exists idx_orders_user on public.orders (user_id, created_at desc);
create index if not exists idx_order_items_order on public.order_items (order_id);
